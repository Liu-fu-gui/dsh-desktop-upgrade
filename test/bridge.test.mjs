/**
 * Host-side tests: SemVer rules, the official-flow wrappers, and the two
 * same-origin bridge routes. Runs with plain node (bridge.js has no imports).
 *
 *   node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BRIDGE_PREFIX,
  MANUAL_DOWNLOAD_URL,
  STATUS_PATH,
  UPGRADE_PATH,
  checkVersion,
  compareSemver,
  createBridgeHandler,
  isTrustedBridgeRequest,
  parseSemver,
  runFlow,
  unavailableMessage
} from '../bridge.js'

const LOOPBACK_HEADERS = { host: '127.0.0.1:43120', accept: 'application/json' }

/** Minimal ServerResponse stand-in. */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: undefined,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
      return this
    },
    end(body) {
      if (body !== undefined && body !== null) this.body += Buffer.isBuffer(body) ? body.toString('utf8') : String(body)
    },
    json() {
      return JSON.parse(this.body)
    }
  }
}

/** Minimal IncomingMessage stand-in (async-iterable body). */
function fakeRequest({ method = 'GET', url = STATUS_PATH, headers = LOOPBACK_HEADERS, body = '' } = {}) {
  const chunks = body === '' ? [] : [Buffer.from(body, 'utf8')]
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    }
  }
}

/** Updates adapter double: records the calls the plugin makes. */
function fakeUpdates(overrides = {}) {
  const calls = []
  return {
    calls,
    currentVersion: '2.0.10',
    releaseChannel: 'stable',
    isPackaged: true,
    canDownload: true,
    async request(url, init) {
      calls.push({ kind: 'request', url, init })
      return { status: 200, async text() {
        return JSON.stringify({ version: overrides.latest ?? '2.0.11' })
      } }
    },
    async confirmDownload(version) {
      calls.push({ kind: 'confirm', version })
      return overrides.accepted ?? true
    },
    async downloadAndOpen(version) {
      calls.push({ kind: 'download', version })
    }
  }
}

test('parseSemver rejects loose versions and accepts strict ones', () => {
  assert.equal(parseSemver('2.0.11').version, '2.0.11')
  assert.equal(parseSemver('v2.0.11').version, '2.0.11')
  assert.equal(parseSemver('2.0'), null)
  assert.equal(parseSemver('2.0.0.1'), null)
  assert.equal(parseSemver(undefined), null)
})

test('compareSemver follows SemVer §11, including prereleases', () => {
  assert.equal(compareSemver('2.0.11', '2.0.10'), 1)
  assert.equal(compareSemver('2.0.10', '2.0.11'), -1)
  assert.equal(compareSemver('2.0.10', '2.0.10'), 0)
  assert.equal(compareSemver('2.0.10-beta.1', '2.0.10'), -1)
  assert.equal(compareSemver('2.0.11-beta.1', '2.0.10'), 1)
  assert.equal(compareSemver('1.10.0', '1.9.0'), 1)
  assert.equal(compareSemver('nonsense', '1.0.0'), null)
})

test('checkVersion reports update-available against the official service', async () => {
  const updates = fakeUpdates()
  const checked = await checkVersion(updates)
  assert.equal(checked.status, 'update-available')
  assert.equal(checked.currentVersion, '2.0.10')
  assert.equal(checked.latestVersion, '2.0.11')
  assert.equal(checked.channel, 'stable')
  assert.equal(updates.calls[0].kind, 'request')
})

test('runFlow never downloads without a confirmed dialog', async () => {
  const declined = fakeUpdates({ accepted: false })
  const declinedOutcome = await runFlow(declined, 'upgrade')
  assert.equal(declinedOutcome.status, 'cancelled')
  assert.equal(declined.calls.some((call) => call.kind === 'download'), false)

  const accepted = fakeUpdates()
  const acceptedOutcome = await runFlow(accepted, 'upgrade')
  assert.equal(acceptedOutcome.accepted, true)
  assert.equal(accepted.calls.some((call) => call.kind === 'download'), true)
})

test('runFlow in status mode only reads versions', async () => {
  const updates = fakeUpdates()
  const outcome = await runFlow(updates, 'status')
  assert.equal(outcome.status, 'update-available')
  assert.equal(outcome.accepted, false)
  assert.deepEqual(updates.calls.map((call) => call.kind), ['request'])
})

test('unavailableMessage explains a missing or unpackaged runtime', () => {
  assert.match(unavailableMessage(undefined), /desktopRuntime/)
  assert.match(unavailableMessage({ isPackaged: false }), /非打包模式/)
  assert.equal(unavailableMessage({ isPackaged: true }), undefined)
})

test('the bridge fence only trusts loopback and trusted authorities', () => {
  assert.equal(isTrustedBridgeRequest(fakeRequest(), []), true)
  assert.equal(isTrustedBridgeRequest(fakeRequest({ headers: { host: 'localhost:43120' } }), []), true)
  assert.equal(isTrustedBridgeRequest(fakeRequest({ headers: { host: '10.0.0.5:43120' } }), []), false)
  assert.equal(isTrustedBridgeRequest(fakeRequest({ headers: { host: '10.0.0.5:43120' } }), ['10.0.0.5:43120']), true)
  assert.equal(
    isTrustedBridgeRequest(fakeRequest({ headers: { ...LOOPBACK_HEADERS, 'sec-fetch-site': 'cross-site' } }), []),
    false
  )
  assert.equal(
    isTrustedBridgeRequest(fakeRequest({ headers: { ...LOOPBACK_HEADERS, origin: 'https://evil.example' } }), []),
    false
  )
})

/** Build a handler over one updates adapter. */
function bridge(updates, trustedHosts = []) {
  return createBridgeHandler({ resolveUpdates: () => updates, resolveTrustedHosts: () => trustedHosts })
}

test('status route answers with the version payload and no dialog', async () => {
  const updates = fakeUpdates()
  const response = fakeResponse()
  await bridge(updates)(fakeRequest({ url: STATUS_PATH }), response)
  assert.equal(response.statusCode, 200)
  const payload = response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.result.status, 'update-available')
  assert.equal(payload.result.latestVersion, '2.0.11')
  assert.equal(payload.result.manualUrl, MANUAL_DOWNLOAD_URL)
  assert.equal(updates.calls.some((call) => call.kind === 'confirm'), false)
})

test('upgrade route confirms and hands the installer download over', async () => {
  const updates = fakeUpdates()
  const response = fakeResponse()
  await bridge(updates)(fakeRequest({ method: 'POST', url: UPGRADE_PATH, body: '{}' }), response)
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().result.accepted, true)
  assert.deepEqual(updates.calls.map((call) => call.kind), ['request', 'confirm', 'download'])
})

test('bridge refuses foreign hosts, wrong methods and unknown paths', async () => {
  const forbidden = fakeResponse()
  await bridge(fakeUpdates())(fakeRequest({ headers: { host: 'evil.example.com' } }), forbidden)
  assert.equal(forbidden.statusCode, 403)

  const wrongMethod = fakeResponse()
  await bridge(fakeUpdates())(fakeRequest({ method: 'GET', url: UPGRADE_PATH }), wrongMethod)
  assert.equal(wrongMethod.statusCode, 405)

  const unknown = fakeResponse()
  await bridge(fakeUpdates())(fakeRequest({ url: `${BRIDGE_PREFIX}/nope` }), unknown)
  assert.equal(unknown.statusCode, 404)

  const headRequest = fakeResponse()
  await bridge(fakeUpdates())(fakeRequest({ method: 'HEAD', url: STATUS_PATH }), headRequest)
  assert.equal(headRequest.statusCode, 200)
})

test('bridge reports an unavailable desktop runtime instead of failing', async () => {
  const response = fakeResponse()
  await bridge(undefined)(fakeRequest({ url: STATUS_PATH }), response)
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().result.status, 'unavailable')
})

test('bridge surfaces a version-service failure as a 500', async () => {
  const broken = { ...fakeUpdates(), request: async () => ({ status: 503, text: async () => '' }) }
  const response = fakeResponse()
  await bridge(broken)(fakeRequest({ url: STATUS_PATH }), response)
  assert.equal(response.statusCode, 500)
  assert.equal(response.json().ok, false)
})
