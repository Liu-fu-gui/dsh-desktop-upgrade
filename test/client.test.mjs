/**
 * Browser-half tests: the bundle registers under the package id, exports a
 * Cordis plugin, and registers the settings.section contribution. When a React
 * copy is reachable (the Desktop app ships one) the component is also rendered
 * once through a minimal hook dispatcher, so hook-order mistakes fail here
 * instead of in the settings page.
 *
 *   node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Load the bundle once with a stand-in module loader and return its factory. */
let bundlePromise
function loadBundle() {
  if (bundlePromise === undefined) {
    const loads = []
    globalThis.window = { __ModuleLoader__: { load: (spec) => loads.push(spec) } }
    bundlePromise = import('../client.js').then(() => {
      assert.equal(loads.length, 1, 'the bundle must call __ModuleLoader__.load exactly once')
      return loads[0]
    })
  }
  return bundlePromise
}

/** Resolve a React copy from the Desktop app, if this machine has one. */
function resolveReact() {
  const candidates = [
    process.env.DSH_DESKTOP_APP,
    'D:/ruanjian/DSH Desktop/resources/app',
    join(process.env.APPDATA ?? '', 'DSH Desktop')
  ].filter((entry) => typeof entry === 'string' && entry !== '')
  for (const candidate of candidates) {
    if (!existsSync(join(candidate, 'node_modules', 'react', 'package.json'))) continue
    try {
      return createRequire(join(candidate, 'package.json'))('react')
    } catch {
      continue
    }
  }
  return undefined
}

/** Render one function component through a minimal hook dispatcher. */
function renderWithHooks(React, Component, props) {
  const internals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const dispatcher = internals === undefined ? undefined : internals.ReactCurrentDispatcher
  if (dispatcher === undefined) return undefined
  const memo = []
  let cursor = 0
  const previous = dispatcher.current
  dispatcher.current = {
    useState(initial) {
      const index = cursor++
      if (!(index in memo)) memo[index] = typeof initial === 'function' ? initial() : initial
      return [memo[index], (next) => {
        memo[index] = typeof next === 'function' ? next(memo[index]) : next
      }]
    },
    useReducer(reducer, initial) {
      const index = cursor++
      if (!(index in memo)) memo[index] = initial
      return [memo[index], (action) => {
        memo[index] = reducer(memo[index], action)
      }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in memo)) memo[index] = { current: initial }
      return memo[index]
    },
    useCallback(fn) {
      cursor += 1
      return fn
    },
    useMemo(fn) {
      cursor += 1
      return fn()
    },
    useEffect() {
      cursor += 1
    },
    useLayoutEffect() {
      cursor += 1
    },
    useInsertionEffect() {
      cursor += 1
    },
    useImperativeHandle() {
      cursor += 1
    },
    useDebugValue() {},
    useContext() {
      cursor += 1
      return undefined
    },
    useId() {
      cursor += 1
      return ':r0:'
    },
    useTransition() {
      cursor += 1
      return [false, (fn) => fn()]
    },
    useDeferredValue(value) {
      cursor += 1
      return value
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      cursor += 1
      return getSnapshot()
    },
    useOptimistic(value) {
      cursor += 1
      return value
    }
  }
  try {
    return Component(props)
  } finally {
    dispatcher.current = previous
  }
}

/** Collect every string child of a React element tree. */
function collectText(node, out = []) {
  if (typeof node === 'string') {
    out.push(node)
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (node !== null && typeof node === 'object' && node.props !== undefined) {
    collectText(node.props.children, out)
  }
  return out
}

test('the bundle registers the package id and exports a Cordis plugin', async () => {
  const spec = await loadBundle()
  assert.equal(spec.id, 'dsh-desktop-upgrade')
  assert.equal(typeof spec.factory, 'function')

  const plugin = spec.factory((id) => {
    assert.equal(id, 'react', 'react is the bundle\'s only external')
    return { createElement: () => null }
  })
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply registers the settings.section contribution', async () => {
  const spec = await loadBundle()
  const React = resolveReact()
  const plugin = spec.factory(() => React)

  const registrations = []
  const dictionaries = {}
  const injected = []
  const ctx = {
    locale: {
      bind: () => (key) => key,
      register: (namespace, dictionary) => {
        dictionaries[namespace] = dictionary
        return () => {}
      }
    },
    slots: {
      inject: (name, callback) => {
        injected.push(name)
        return callback()
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      }
    },
    effect: (fn) => fn()
  }
  plugin.apply(ctx)

  assert.deepEqual(injected, ['settings.section'])
  assert.equal(registrations.length, 1)
  const { options, component } = registrations[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'desktop-upgrade')
  assert.equal(typeof options.order, 'number')
  assert.equal(options.locale, 'dsh-desktop-upgrade')
  assert.equal(options.label(), 'nav')
  assert.deepEqual(Object.keys(options.inject()), ['t'])
  assert.equal(typeof component, 'function')
  assert.equal(dictionaries['dsh-desktop-upgrade'].en.nav, 'DSH Upgrade')
})

test('the settings component renders through a hook dispatcher', async () => {
  const spec = await loadBundle()
  const React = resolveReact()
  if (React === undefined) {
    // No React on this machine: the loader-level assertions above still ran.
    return
  }
  const plugin = spec.factory(() => React)
  let component
  plugin.apply({
    locale: { bind: () => (key) => key, register: () => () => {} },
    slots: {
      inject: (_name, callback) => callback(),
      register: (_options, registered) => {
        component = registered
        return () => {}
      }
    },
    effect: (fn) => fn()
  })

  const internals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const exposesDispatcher = internals !== undefined && internals.ReactCurrentDispatcher !== undefined
  const element = renderWithHooks(React, component, { t: (key) => key })
  if (element === undefined) {
    assert.equal(exposesDispatcher, false, 'React exposes a hook dispatcher, so the component must render')
    return
  }
  assert.equal(element.type, 'div')
  const text = collectText(element)
  assert.ok(text.includes('title'), 'the section title must render')
  assert.ok(text.includes('description'), 'the description must render')
  assert.ok(text.includes('checking'), 'the initial state must be the loading state')
})
