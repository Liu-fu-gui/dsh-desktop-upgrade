/**
 * dsh-desktop-upgrade — Host-side upgrade core and browser bridge.
 *
 * Everything here is plain host logic: the official version check, the shared
 * check → confirm → download flow, and the two same-origin routes the
 * settings-page UI talks to. The Cordis wiring (tray item, model tool) stays in
 * `index.js`; this module imports nothing but the platform.
 *
 * Routes, fenced to loopback / the web runtime's trusted hosts:
 *   GET  /dsh-desktop-upgrade/status   → { ok: true, result }
 *   POST /dsh-desktop-upgrade/upgrade  → { ok: true, result }
 *
 * The upgrade route never installs anything by itself: it asks the Desktop's
 * own `desktopRuntime.updates` adapter for the native confirmation dialog and
 * then hands the official installer download to the OS, exactly like the
 * official tray entry does.
 *
 * @module dsh-desktop-upgrade/bridge
 */

/** Public DSH Desktop release service. */
const VERSION_ENDPOINT = 'https://www.dshdesktop.cn/api/desktop/version'
/** Header carrying the installed Desktop version. */
const CURRENT_VERSION_HEADER = 'X-DSH-Desktop-Version'
/** Header selecting an isolated Desktop release stream. */
const CHANNEL_HEADER = 'X-DSH-Desktop-Channel'
/** Maximum accepted response body size. */
const MAX_BODY_CHARS = 4096
/** Prefix of every route this plugin owns. */
export const BRIDGE_PREFIX = '/dsh-desktop-upgrade'
/** Route that only reports versions. */
export const STATUS_PATH = `${BRIDGE_PREFIX}/status`
/** Route that runs the confirm → download hand-off. */
export const UPGRADE_PATH = `${BRIDGE_PREFIX}/upgrade`
/** Manual fallback offered when the app cannot download installers itself. */
export const MANUAL_DOWNLOAD_URL = 'https://www.dshdesktop.cn'

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/** Parse strict SemVer with an optional lowercase v prefix. */
export function parseSemver(value) {
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
export function compareSemver(left, right) {
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
export async function checkVersion(updates) {
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
export function result(status, message, extra = {}) {
  const payload = { status, message }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) payload[key] = value
  }
  return payload
}

/** Run the shared check → confirm → download-handoff flow. */
export async function runFlow(updates, mode) {
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
  if (mode === 'check' || mode === 'status') {
    return result('update-available', '发现新版本 ' + checked.latestVersion + '（当前 ' + checked.currentVersion + '）。', { ...base, accepted: false })
  }
  if (base.canDownload !== true) {
    return result(
      'update-available',
      '发现新版本 ' + checked.latestVersion + '，但当前平台不支持在应用内下载安装包，请到 ' + MANUAL_DOWNLOAD_URL + ' 手动下载。',
      { ...base, accepted: false, manualUrl: MANUAL_DOWNLOAD_URL }
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
export function unavailableMessage(updates) {
  if (updates === undefined) return '当前主机没有 DSH Desktop 原生运行时（desktopRuntime），本插件只在 DSH Desktop 发行版中可用。'
  if (updates.isPackaged !== true) return '当前 DSH Desktop 运行在非打包模式下，官方安装包通道不可用。'
  return undefined
}

// ── same-origin bridge ───────────────────────────────────────────────────────

/** Write one JSON response. */
function writeJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store'
  })
  response.end(body)
}

/** Read a small JSON body, tolerating an empty one. */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_CHARS) throw new Error('请求体超出预期大小')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

function header(headers, name) {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * Same trust fence as the web runtime's own routes: the Host header must be
 * loopback or explicitly trusted, and a browser cross-site marker is refused,
 * so a random web page cannot drive the native installer dialog.
 */
export function isTrustedBridgeRequest(request, trustedHosts = []) {
  const host = header(request.headers ?? {}, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(request.headers ?? {}, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers ?? {}, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * Build the route handler.
 *
 * @param options.resolveUpdates - Late-bound getter for the Desktop updates adapter.
 * @param options.resolveTrustedHosts - Late-bound getter for the web runtime's trusted hosts.
 */
export function createBridgeHandler({ resolveUpdates, resolveTrustedHosts }) {
  return async function handleBridgeRequest(request, response) {
    const trustedHosts = typeof resolveTrustedHosts === 'function' ? resolveTrustedHosts() ?? [] : []
    if (!isTrustedBridgeRequest(request, trustedHosts)) {
      writeJson(response, 403, { ok: false, error: { code: 'forbidden', message: '仅允许本机页面访问 DSH 升级桥接。' } })
      return
    }
    let pathname
    try {
      pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname
    } catch {
      writeJson(response, 400, { ok: false, error: { code: 'bad-request', message: '无法解析请求路径。' } })
      return
    }
    const method = request.method ?? 'GET'
    const isStatus = pathname === STATUS_PATH
    const isUpgrade = pathname === UPGRADE_PATH
    if (!isStatus && !isUpgrade) {
      writeJson(response, 404, { ok: false, error: { code: 'not-found', message: '未知的 DSH 升级接口。' } })
      return
    }
    if (isStatus && method !== 'GET' && method !== 'HEAD') {
      writeJson(response, 405, { ok: false, error: { code: 'method-not-allowed', message: 'status 只接受 GET。' } })
      return
    }
    if (isUpgrade && method !== 'POST') {
      writeJson(response, 405, { ok: false, error: { code: 'method-not-allowed', message: 'upgrade 只接受 POST。' } })
      return
    }
    try {
      if (isUpgrade) await readJsonBody(request)
      const updates = typeof resolveUpdates === 'function' ? resolveUpdates() : undefined
      const unavailable = unavailableMessage(updates)
      if (unavailable !== undefined) {
        writeJson(response, 200, { ok: true, result: result('unavailable', unavailable) })
        return
      }
      const flow = isStatus ? await runFlow(updates, 'status') : await runFlow(updates, 'upgrade')
      writeJson(response, 200, { ok: true, result: { ...flow, manualUrl: flow.manualUrl ?? MANUAL_DOWNLOAD_URL } })
    } catch (failure) {
      writeJson(response, 500, {
        ok: false,
        error: { code: 'upgrade-failed', message: failure instanceof Error ? failure.message : String(failure) }
      })
    }
  }
}

/**
 * Register both bridge routes on the profile's web server.
 *
 * @param ctx - Cordis context that owns a live `webServer` service.
 */
export function registerBridge(ctx) {
  const handler = createBridgeHandler({
    resolveUpdates: () => ctx.get('desktopRuntime')?.updates,
    resolveTrustedHosts: () => ctx.get('webRuntime')?.trustedHosts
  })
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: STATUS_PATH, handler }),
    'dsh-desktop-upgrade: status bridge'
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: UPGRADE_PATH, handler }),
    'dsh-desktop-upgrade: upgrade bridge'
  )
}
