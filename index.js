/**
 * dsh-desktop-upgrade — 给 DSH Desktop 补上它缺的那个「升级 DSH」入口。
 *
 * 背景：DSH Desktop 的 Web 设置页没有检查更新按钮（client.js 里那个
 * checkForUpdates API 从未被渲染），官方入口只藏在系统托盘的「检查更新…」。
 * 本插件复用桌面版自己的 desktopRuntime.updates 适配器，补三件事：
 *
 *   1. Web 设置页新增「DSH 升级」分区（client.js）：显示当前/官方版本，
 *      一键检查更新、一键下载官方安装包（仍会弹原生确认框）。
 *   2. 托盘菜单新增「升级 DSH…」：检查官方版本服务 → 有新版时弹原生确认框
 *      → 下载官方安装包并打开（与官方托盘项完全同一条链路）。
 *   3. 给模型一个 dsh_upgrade 工具，可以在对话里直接查版本 / 触发升级。
 *
 * 它不修改任何内核文件：桌面版内核位于 app 目录，profile 看到的只是
 * junction，真正的升级只能由官方安装包完成。
 *
 * @module dsh-desktop-upgrade
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  checkVersion,
  compareSemver,
  parseSemver,
  registerBridge,
  result,
  runFlow,
  unavailableMessage
} from './bridge.js'

/** Stable Cordis plugin name. */
export const name = 'desktop-upgrade'

/** The agent tool runtime; the native desktop runtime is injected lazily. */
export const inject = ['tools']

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

/** Register the Web settings-page bridge the client half talks to. */
function installBridge(ctx) {
  ctx.inject(['webServer'], (scoped) => {
    registerBridge(scoped)
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
 * Register the Web bridge, the native tray entry and the model tool.
 * @param ctx - host context carrying the agent tool runtime.
 */
export function apply(ctx) {
  installTool(ctx)
  installTrayItem(ctx)
  installBridge(ctx)
}

/** Exposed for tests and for other plugins that want the raw comparison. */
export { checkVersion, compareSemver, parseSemver }
