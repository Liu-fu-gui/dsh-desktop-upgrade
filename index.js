/**
 * dsh-desktop-upgrade — 给 DSH Desktop 补上它缺的那个「升级 DSH」入口。
 *
 * 背景：DSH Desktop 的 Web 设置页没有检查更新按钮（client.js 里那个
 * checkForUpdates API 从未被渲染），官方入口只藏在系统托盘的「检查更新…」。
 * 本插件复用桌面版自己的 desktopRuntime.updates 适配器，补两件事：
 *
 *   1. 托盘菜单新增「升级 DSH…」：检查官方版本服务 → 有新版时弹原生确认框
 *      → 下载官方安装包并打开（与官方托盘项完全同一条链路）。
 *   2. 给模型一个 dsh_upgrade 工具，可以在对话里直接查版本 / 触发升级。
 *
 * 它不修改任何内核文件：桌面版内核位于 app 目录，profile 看到的只是
 * junction，真正的升级只能由官方安装包完成。
 *
 * @module dsh-desktop-upgrade
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

/** Stable Cordis plugin name. */
export const name = 'desktop-upgrade'

/** The agent tool runtime; the native desktop runtime is injected lazily. */
export const inject = ['tools']

/** Public DSH Desktop release service. */
const VERSION_ENDPOINT = 'https://www.dshdesktop.cn/api/desktop/version'
/** Header carrying the installed Desktop version. */
const CURRENT_VERSION_HEADER = 'X-DSH-Desktop-Version'
/** Header selecting an isolated Desktop release stream. */
const CHANNEL_HEADER = 'X-DSH-Desktop-Channel'
/** Maximum accepted response body size. */
const MAX_BODY_CHARS = 4096

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/** Parse strict SemVer with an optional lowercase v prefix. */
function parseSemver(value) {
  if (typeof value !== 'string') return null
  const raw = value.startsWith('v') ? value.slice(1) : value
  const match = SEMVER_PATTERN.exec(raw)
  if (match === null) return null
  const prerelease = match[4] === undefined ? [] : match[4].split('.')
  if (prerelease.some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))) return null
  return {
    version: raw,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease
  }
}

/** Compare prerelease identifier lists per SemVer §11. */
function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) {
      const difference = Number(a) - Number(b)
      if (difference !== 0) return difference < 0 ? -1 : 1
      continue
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/** Compare two version strings; null when either side is not strict SemVer. */
function compareSemver(left, right) {
  const a = parseSemver(left)
  const b = parseSemver(right)
  if (a === null || b === null) return null
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  return comparePrerelease(a.prerelease, b.prerelease)
}

/** Read the small JSON version response. */
async function readVersionBody(response) {
  const text = await response.text()
  if (text.length > MAX_BODY_CHARS) throw new Error('版本服务响应超出预期大小')
  return JSON.parse(text)
}

/**
 * Ask the official Desktop version service for the newest release in the
 * installed channel, through the Desktop's own Electron network stack.
 */
async function checkVersion(updates) {
  const currentVersion = updates.currentVersion
  const channel = typeof updates.releaseChannel === 'string' ? updates.releaseChannel : 'stable'
  const headers = {
    Accept: 'application/json',
    [CHANNEL_HEADER]: channel
  }
  if (typeof currentVersion === 'string') headers[CURRENT_VERSION_HEADER] = currentVersion
  const response = await updates.request(VERSION_ENDPOINT, {
    method: 'GET',
    headers,
    cache: 'no-store',
    redirect: 'error'
  })
  if (response.status !== 200) throw new Error('版本服务返回 HTTP ' + String(response.status))
  const body = await readVersionBody(response)
  const latestVersion = body !== null && typeof body === 'object' ? body.version : undefined
  if (typeof latestVersion !== 'string' || parseSemver(latestVersion) === null) {
    throw new Error('版本服务返回了无法解析的版本号')
  }
  const comparison = compareSemver(latestVersion, currentVersion)
  return {
    status: comparison !== null && comparison > 0 ? 'update-available' : 'up-to-date',
    currentVersion: typeof currentVersion === 'string' ? currentVersion : 'unknown',
    latestVersion,
    channel
  }
}

/** Build one result payload, dropping absent fields. */
function result(status, message, extra = {}) {
  const payload = { status, message }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) payload[key] = value
  }
  return payload
}

/** Run the shared check → confirm → download-handoff flow. */
async function runFlow(updates, mode) {
  const checked = await checkVersion(updates)
  const base = {
    currentVersion: checked.currentVersion,
    latestVersion: checked.latestVersion,
    channel: checked.channel,
    canDownload: updates.canDownload === true
  }
  if (checked.status !== 'update-available') {
    return result('up-to-date', '已是最新版本（当前 ' + checked.currentVersion + '，官方 ' + checked.latestVersion + '）。', base)
  }
  if (mode === 'check') {
    return result('update-available', '发现新版本 ' + checked.latestVersion + '（当前 ' + checked.currentVersion + '）。', { ...base, accepted: false })
  }
  if (base.canDownload !== true) {
    return result(
      'update-available',
      '发现新版本 ' + checked.latestVersion + '，但当前平台不支持在应用内下载安装包，请到 dshdesktop.cn 手动下载。',
      { ...base, accepted: false }
    )
  }
  const accepted =
    typeof updates.confirmDownload === 'function'
      ? await updates.confirmDownload(checked.latestVersion, checked.channel)
      : false
  if (accepted !== true) {
    return result('cancelled', '已取消，未下载安装包（当前 ' + checked.currentVersion + '，可升级到 ' + checked.latestVersion + '）。', {
      ...base,
      accepted: false
    })
  }
  const controller = new AbortController()
  await updates.downloadAndOpen(checked.latestVersion, controller.signal, checked.channel)
  return result(
    'update-available',
    '已开始下载 DSH Desktop ' + checked.latestVersion + ' 的官方安装包；下载完成后会自动打开，按安装向导完成升级即可。',
    { ...base, accepted: true }
  )
}

/** Describe why the native upgrade channel is unavailable here. */
function unavailableMessage(updates) {
  if (updates === undefined) return '当前主机没有 DSH Desktop 原生运行时（desktopRuntime），本插件只在 DSH Desktop 发行版中可用。'
  if (updates.isPackaged !== true) return '当前 DSH Desktop 运行在非打包模式下，官方安装包通道不可用。'
  return undefined
}

/** Register the native tray entry that mirrors the official update flow. */
function installTrayItem(ctx) {
  ctx.inject(['desktopRuntime'], (scoped) => {
    const runtime = scoped.get('desktopRuntime')
    const updates = runtime?.updates
    if (updates === undefined || updates.isPackaged !== true) return
    const state = { checking: false, available: undefined }
    let handle
    const report = async (operation, failure) => {
      ctx.logger?.error?.('dsh-desktop-upgrade: failed to ' + operation + ': ' + (failure instanceof Error ? failure.message : String(failure)))
      try {
        if (typeof updates.showManualCheckResult === 'function') await updates.showManualCheckResult(null)
      } catch {}
    }
    handle = runtime.registerTrayItem({
      id: 'dsh-upgrade-check',
      group: 'status',
      order: 20,
      label: () =>
        state.checking
          ? '正在检查 DSH 更新…'
          : state.available === undefined
            ? '升级 DSH…'
            : '升级 DSH 到 ' + state.available + '…',
      enabled: () => state.checking !== true,
      invoke: async () => {
        if (state.checking) return
        state.checking = true
        state.available = undefined
        handle.refresh()
        try {
          const outcome = await runFlow(updates, 'upgrade')
          if (outcome.status === 'update-available' && outcome.accepted !== true) state.available = outcome.latestVersion
          if (outcome.status === 'up-to-date' && typeof updates.showManualCheckResult === 'function') {
            await updates.showManualCheckResult({
              status: 'up-to-date',
              currentVersion: outcome.currentVersion,
              latestVersion: outcome.latestVersion
            })
          }
        } catch (failure) {
          await report('upgrade DSH Desktop', failure)
        } finally {
          state.checking = false
          handle.refresh()
        }
      }
    })
    if (typeof scoped.effect === 'function') {
      scoped.effect(() => () => handle.dispose(), 'dsh-desktop-upgrade: native tray entry')
    }
  })
}

/** Register the model-facing tool. */
function installTool(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'dsh_upgrade',
      description:
        'Check and upgrade DSH Desktop itself. action=status returns the installed and latest version without any dialog; action=check only reports whether a newer release exists; action=upgrade asks for on-screen confirmation and then downloads and opens the official DSH Desktop installer. It never patches the bundled harness in place.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          description: "One of 'status', 'check' or 'upgrade'."
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true },
            message: { type: 'string', required: true },
            currentVersion: { type: 'string' },
            latestVersion: { type: 'string' },
            channel: { type: 'string' },
            canDownload: { type: 'boolean' },
            accepted: { type: 'boolean' }
          }
        },
        render: (_args, value) => [{ type: 'text', text: value.message }]
      },
      async execute(args) {
        const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : ''
        if (action !== 'status' && action !== 'check' && action !== 'upgrade') {
          return result('invalid-action', "action 必须是 'status'、'check' 或 'upgrade' 之一。")
        }
        const updates = ctx.get('desktopRuntime')?.updates
        const unavailable = unavailableMessage(updates)
        if (unavailable !== undefined) return result('unavailable', unavailable)
        try {
          if (action === 'status') {
            const checked = await checkVersion(updates)
            return result(
              checked.status,
              'DSH Desktop 当前 ' + checked.currentVersion + '（' + checked.channel + ' 通道），官方最新 ' + checked.latestVersion + '。' +
                (checked.status === 'update-available' ? '可升级。' : '已是最新。'),
              {
                currentVersion: checked.currentVersion,
                latestVersion: checked.latestVersion,
                channel: checked.channel,
                canDownload: updates.canDownload === true
              }
            )
          }
          return await runFlow(updates, action)
        } catch (failure) {
          return result('error', '检查/升级 DSH 失败：' + (failure instanceof Error ? failure.message : String(failure)))
        }
      }
    })
  )
}

/**
 * Register the tray entry and the model tool.
 * @param ctx - host context carrying the agent tool runtime.
 */
export function apply(ctx) {
  installTool(ctx)
  installTrayItem(ctx)
}

/** Exposed for tests and for other plugins that want the raw comparison. */
export { checkVersion, compareSemver, parseSemver }
