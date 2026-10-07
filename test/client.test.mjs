import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../src/client.cjs', import.meta.url), 'utf8')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Exercise the shipped module, slot registration, and component without adding
// React or a DOM dependency. Updates are deliberately batched until render(),
// so two clicks can use the same pre-render handler just as real rapid input can.
function createHarness() {
  const hooks = []
  const effects = []
  const requests = []
  let cursor = 0
  let dirty = false
  let mounted = true
  let stateWrites = 0
  let writesAfterUnmount = 0
  let Component
  let tree
  let plugin
  let slot

  const React = {
    createElement(type, props, ...children) {
      return { type, props: { ...props, children } }
    },
    useState(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
      return [hooks[index], (next) => {
        stateWrites += 1
        if (!mounted) writesAfterUnmount += 1
        hooks[index] = typeof next === 'function' ? next(hooks[index]) : next
        dirty = true
      }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = { current: initial }
      return hooks[index]
    },
    useEffect(create, dependencies) {
      const index = cursor++
      assert.equal(dependencies.length, 0, 'the harness supports mount-only effects')
      if (!(index in hooks)) {
        hooks[index] = true
        effects.push({ create, cleanup: undefined, pending: true })
      }
    },
  }

  vm.runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load(definition) {
          assert.equal(definition.id, 'dsh-minimal-first-turn')
          plugin = definition.factory((name) => {
            assert.equal(name, 'react')
            return React
          })
        },
      },
    },
    fetch(url, options) {
      const pending = deferred()
      requests.push({
        url,
        options,
        reject: pending.reject,
        respond(body, { ok = true, invalidJson = false } = {}) {
          pending.resolve({
            ok,
            json: () => invalidJson ? Promise.reject(new SyntaxError('Invalid JSON')) : Promise.resolve(body),
          })
        },
      })
      return pending.promise
    },
  }, { filename: 'src/client.cjs' })

  plugin.apply({
    inject(services, callback) {
      assert.deepEqual(Array.from(services), ['slots'])
      callback({
        effect(callback) { callback() },
        slots: {
          inject(name, callback) {
            assert.equal(name, 'conversation.input.left')
            return callback()
          },
          register(descriptor, renderSlot) {
            assert.equal(descriptor.name, 'conversation.input.left')
            assert.equal(descriptor.id, 'dsh-minimal-first-turn')
            slot = renderSlot
            return () => {}
          },
        },
      })
    },
  })
  Component = slot().type

  function render() {
    assert.equal(mounted, true)
    cursor = 0
    dirty = false
    tree = Component()
    for (const effect of effects) {
      if (!effect.pending) continue
      effect.pending = false
      effect.cleanup = effect.create()
    }
    return tree
  }

  function find(predicate, node = tree) {
    if (!node || typeof node !== 'object') return undefined
    if (predicate(node)) return node
    for (const child of node.props.children) {
      const found = find(predicate, child)
      if (found) return found
    }
    return undefined
  }

  function byClass(className) { return find((node) => node.props.className === className) }
  function byRole(role) { return find((node) => node.props.role === role) }
  function text(node) {
    if (node === null || node === undefined) return ''
    return typeof node === 'object' ? node.props.children.map(text).join('') : String(node)
  }

  render()
  return {
    requests,
    render,
    byClass,
    byRole,
    text,
    get tree() { return tree },
    get stateWrites() { return stateWrites },
    get writesAfterUnmount() { return writesAfterUnmount },
    async flush() {
      await new Promise((resolve) => setImmediate(resolve))
      if (dirty && mounted) render()
    },
    unmount() {
      mounted = false
      for (const effect of effects) effect.cleanup?.()
    },
    replayEffects() {
      // React development Strict Mode: cleanup then setup with the same refs.
      for (const effect of effects) effect.cleanup?.()
      for (const effect of effects) effect.cleanup = effect.create()
    },
  }
}

function assertUnknown(harness) {
  const button = harness.byClass('dmft-switch')
  assert.equal(button.props.disabled, true)
  assert.equal(button.props['aria-checked'], undefined)
  assert.equal(button.props['data-enabled'], undefined)
  assert.match(button.props['aria-label'], /状态未知/)
  return button
}

async function ready(enabled = true) {
  const harness = createHarness()
  harness.requests[0].respond({ enabled })
  await harness.flush()
  return harness
}

test('loads authoritative state before enabling the accessible switch', async () => {
  const harness = createHarness()
  const loadingButton = assertUnknown(harness)
  assert.equal(harness.byClass('dmft-switch').props['aria-busy'], true)
  assert.equal(harness.byRole('status').props['aria-live'], 'polite')
  assert.equal(harness.tree.props['aria-busy'], undefined, 'busy switch must not suppress its sibling live region')
  assert.match(harness.text(harness.byRole('status')), /加载中/)
  loadingButton.props.onClick()
  assert.equal(harness.requests.length, 1)
  assert.equal(harness.requests[0].url, 'minimal-first-turn/state')
  assert.equal(harness.requests[0].options.method, 'GET')
  assert.equal(harness.requests[0].options.cache, 'no-store')

  harness.requests[0].respond({ enabled: true })
  await harness.flush()
  assert.equal(harness.byRole('switch').props['aria-checked'], true)
  assert.equal(harness.byRole('switch').props.disabled, false)
  assert.equal(harness.byClass('dmft-switch').props['aria-busy'], false)
  assert.equal(harness.byRole('alert'), undefined)
})

for (const [documentBase, expected] of [
  ['https://dsh.example/', 'https://dsh.example/minimal-first-turn/state'],
  ['https://dsh.example/tools/dsh/', 'https://dsh.example/tools/dsh/minimal-first-turn/state'],
  ['https://dsh.example/tools/dsh/index.html', 'https://dsh.example/tools/dsh/minimal-first-turn/state'],
]) {
  test(`GET and POST preserve the DSH document base ${documentBase}`, async () => {
    const harness = await ready(true)
    assert.equal(new URL(harness.requests[0].url, documentBase).href, expected)
    harness.byRole('switch').props.onClick()
    assert.equal(new URL(harness.requests[1].url, documentBase).href, expected)
  })
}

test('a valid false value is ready and can be enabled', async () => {
  const harness = await ready(false)
  assert.equal(harness.byRole('switch').props['aria-checked'], false)
  harness.byRole('switch').props.onClick()
  assert.deepEqual(JSON.parse(harness.requests[1].options.body), { enabled: true })
})

test('failed GET stays unknown and retries reading before any mutation', async () => {
  const harness = createHarness()
  const oldClick = harness.byClass('dmft-switch').props.onClick
  harness.requests[0].reject(new Error('offline'))
  await harness.flush()
  assertUnknown(harness).props.onClick()
  oldClick()
  assert.equal(harness.requests.length, 1)
  assert.equal(harness.byClass('dmft-switch').props['aria-busy'], false)
  assert.match(harness.text(harness.byRole('alert')), /无法读取/)

  const retry = harness.byClass('dmft-retry').props.onClick
  retry()
  retry()
  assert.equal(harness.requests.length, 2, 'same-tick retries issue only one read')
  assert.equal(harness.requests[1].options.method, 'GET')
  harness.render()
  assertUnknown(harness)
  assert.equal(harness.byRole('alert'), undefined)
  harness.requests[1].respond({ enabled: true })
  await harness.flush()
  harness.byRole('switch').props.onClick()
  assert.deepEqual(JSON.parse(harness.requests[2].options.body), { enabled: false })
})

for (const [description, body, options] of [
  ['null', null],
  ['array', []],
  ['missing enabled', {}],
  ['string enabled', { enabled: 'true' }],
  ['numeric enabled', { enabled: 0 }],
  ['null enabled', { enabled: null }],
  ['scalar', 'true'],
  ['invalid JSON', undefined, { invalidJson: true }],
  ['HTTP failure', { enabled: false }, { ok: false }],
]) {
  test(`rejects ${description} state responses instead of guessing disabled`, async () => {
    const harness = createHarness()
    harness.requests[0].respond(body, options)
    await harness.flush()
    assertUnknown(harness).props.onClick()
    assert.equal(harness.requests.length, 1)
    assert.ok(harness.byRole('alert'))
    assert.ok(harness.byClass('dmft-retry'))
  })
}

test('rapid clicks issue one POST and stale handlers use the latest confirmed state', async () => {
  const harness = await ready(true)
  const click = harness.byRole('switch').props.onClick
  click()
  click()
  assert.equal(harness.requests.length, 2)
  const save = harness.requests[1]
  assert.equal(save.options.method, 'POST')
  assert.equal(save.options.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(save.options.body), { enabled: false })
  harness.render()
  assert.equal(harness.byClass('dmft-switch').props['aria-busy'], true)
  assert.equal(harness.byRole('switch').props.disabled, true)
  assert.equal(harness.byRole('switch').props['aria-checked'], true, 'no optimistic lie about server state')
  assert.match(harness.text(harness.byRole('status')), /保存中/)
  harness.byRole('switch').props.onClick()
  assert.equal(harness.requests.length, 2)

  save.respond({ enabled: false })
  await harness.flush()
  assert.equal(harness.byRole('switch').props['aria-checked'], false)
  assert.equal(harness.byRole('switch').props.disabled, false)
  click()
  assert.equal(harness.requests.length, 3)
  assert.deepEqual(JSON.parse(harness.requests[2].options.body), { enabled: true })
})

test('uses the server state returned by POST rather than assuming the requested state', async () => {
  const harness = await ready(true)
  harness.byRole('switch').props.onClick()
  harness.requests[1].respond({ enabled: true })
  await harness.flush()
  assert.equal(harness.byRole('switch').props['aria-checked'], true)
})

for (const failure of ['network', 'HTTP', 'malformed', 'invalid JSON']) {
  test(`a ${failure} POST failure requires a fresh read before toggling again`, async () => {
    const harness = await ready(false)
    const oldClick = harness.byRole('switch').props.onClick
    oldClick()
    const save = harness.requests[1]
    if (failure === 'network') save.reject(new Error('connection lost after write'))
    if (failure === 'HTTP') save.respond({ error: 'write failed' }, { ok: false })
    if (failure === 'malformed') save.respond({ enabled: 'true' })
    if (failure === 'invalid JSON') save.respond(undefined, { invalidJson: true })
    await harness.flush()
    assertUnknown(harness).props.onClick()
    oldClick()
    assert.equal(harness.requests.length, 2)
    assert.match(harness.text(harness.byRole('alert')), /保存失败/)
    harness.byClass('dmft-retry').props.onClick()
    assert.equal(harness.requests[2].options.method, 'GET', 'retry does not blindly repeat a mutation')
    harness.requests[2].respond({ enabled: true })
    await harness.flush()
    harness.byRole('switch').props.onClick()
    assert.deepEqual(JSON.parse(harness.requests[3].options.body), { enabled: false })
  })
}

for (const method of ['GET', 'POST']) {
  for (const failure of [false, true]) {
    test(`ignores ${method} ${failure ? 'failure' : 'success'} after unmount`, async () => {
      const harness = method === 'GET' ? createHarness() : await ready(true)
      if (method === 'POST') harness.byRole('switch').props.onClick()
      const pending = harness.requests.at(-1)
      const oldClick = harness.byClass('dmft-switch').props.onClick
      harness.unmount()
      const before = harness.stateWrites
      if (failure) pending.reject(new Error('offline'))
      else pending.respond({ enabled: false })
      await harness.flush()
      oldClick()
      assert.equal(harness.stateWrites, before)
      assert.equal(harness.writesAfterUnmount, 0)
      assert.equal(harness.requests.length, method === 'GET' ? 1 : 2)
    })
  }
}

test('an old effect GET cannot overwrite the new effect result after Strict Mode replay', async () => {
  const harness = createHarness()
  harness.replayEffects()
  assert.equal(harness.requests.length, 2)
  harness.requests[1].respond({ enabled: true })
  await harness.flush()
  const before = harness.stateWrites
  harness.requests[0].respond({ enabled: false })
  await harness.flush()
  assert.equal(harness.stateWrites, before)
  assert.equal(harness.byRole('switch').props['aria-checked'], true)
})

test('an old effect POST cannot overwrite a new effect state', async () => {
  const harness = await ready(true)
  harness.byRole('switch').props.onClick()
  const oldSave = harness.requests[1]
  harness.replayEffects()
  harness.requests[2].respond({ enabled: true })
  await harness.flush()
  const before = harness.stateWrites
  oldSave.respond({ enabled: false })
  await harness.flush()
  assert.equal(harness.stateWrites, before)
  assert.equal(harness.byRole('switch').props['aria-checked'], true)
})
