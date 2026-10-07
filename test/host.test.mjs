import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import * as plugin from '../src/host.mjs'

const persona = 'You are a helpful software engineer assistant.'
const message = kind => ({ id: `message-${kind}`, role: 'user', content: [{ type: 'text', text: kind }], source: { kind } })

async function harness(t, { header = {}, events = [], complete, initialEnabled, badPath = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dmft-test-'))
  if (badPath) writeFileSync(join(home, 'blocked'), 'not a directory')
  if (initialEnabled !== undefined) {
    mkdirSync(join(home, 'plugins'))
    writeFileSync(join(home, 'plugins/dsh-minimal-first-turn.json'), JSON.stringify({ enabled: initialEnabled }))
  }
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = badPath ? join(home, 'blocked') : home
  let route
  const definitions = new Map()
  const ctx = new Context()
  ctx.provide('connection', { requestRejection: req => {
    if (req.headers.cookie === 'unauthenticated') return 401
    if (req.headers.origin !== undefined && req.headers.origin !== 'http://localhost:1234') return 403
    if (req.headers['sec-fetch-site'] === 'cross-site') return 403
    return undefined
  } })
  ctx.provide('agents', { list: () => [agent] })
  ctx.provide('webServer', { register: value => { route = value; return () => {} } })
  // The production service drives the same fold over persisted history. Keep
  // history private here: modern DSH intentionally exposes no session.events.
  ctx.provide('sessionProjections', {
    register: definition => { definitions.set(definition.key, definition); return () => definitions.delete(definition.key) },
    stateOf: (_session, key) => {
      const definition = definitions.get(key)
      return definition && events.reduce(definition.apply, definition.init())
    },
  })
  ctx.provide('sandboxPolicy', {})
  ctx.provide('subprocess', {})
  await ctx.plugin(SystemPrompt, { personaPrefix: 'Original persona' })
  await ctx.plugin(Tools)
  ctx.systemPrompt.context({ name: 'runtime', order: 1, text: 'Runtime facts' })
  for (const name of ['bash', 'read']) ctx.tools.register({
    name, description: `original ${name}`, parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => name,
  })
  const agent = { id: 'test', session: { id: 'test', header, append: (type, data) => { const event = { type, data, seq: events.length }; events.push(event); return event } }, whenIdle: async () => {}, inject: () => {} }
  const scope = createScope(ctx, agent)
  agent.ctx = scope.ctx
  if (complete !== undefined) await agent.ctx.plugin({ inject: ['systemPrompt'], apply: context => { context.systemPrompt.section({ name: 'deployment:persona-prefix', text: complete, order: 0, complete: true }) } })
  const fiber = ctx.plugin(plugin)
  await fiber
  if (previous === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previous
  t.after(async () => { await fiber.dispose(); await scope.dispose(); await ctx.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  const request = async (method = 'GET', body, headers = {}) => {
    let status, result
    const req = { method, headers: { host: 'localhost:1234', 'content-type': 'application/json', ...headers }, async *[Symbol.asyncIterator]() { if (body !== undefined) yield typeof body === 'string' ? body : JSON.stringify(body) } }
    await route.handler(req, { writeHead: code => { status = code }, end: data => { result = JSON.parse(data) } })
    return { status, body: result }
  }
  return {
    ctx, agent, events, fiber, request, home,
    assemble: () => ctx.systemPrompt.assemble({ agent, scope: agent }),
    preStep: (messages, kind = 'enter') => ctx.waterfall(scopeTarget(ctx, agent), 'agent/pre-step', { agent, messages }, async () => ({ kind, messages })),
  }
}

test('latest runtime: first request has official Bash, reduced prompt/context; later request restores executing tool', async t => {
  const h = await harness(t)
  const first = await h.assemble()
  assert.deepEqual(first.sections.map(section => section.text), [persona])
  assert.deepEqual(first.contexts, [])
  assert.deepEqual(first.tools.map(tool => tool.name), ['bash'])
  assert.match(first.tools[0].description, /Network access depends/)
  assert.equal(h.ctx.tools.get('bash', h.agent).description, first.tools[0].description)
  assert.deepEqual((await h.preStep([message('user'), message('agent-instructions'), message('skill-catalog')])).messages, [message('user')])
  h.events.push({ type: 'tool/call' })
  // A durable call must not unload the provider BEFORE that call executes.
  assert.match(h.ctx.tools.get('bash', h.agent).description, /Run commands/)
  const second = await h.assemble()
  assert.deepEqual(second.tools.map(tool => tool.name), ['bash', 'read'])
  assert.equal(h.ctx.tools.get('bash', h.agent).description, 'original bash')
  assert.ok(second.sections.some(section => section.text === 'Original persona'))
  assert.equal(second.contexts[0].text, 'Runtime facts')
  assert.equal((await h.preStep([message('agent-instructions')])).messages.length, 1)
})

test('resume and compaction are derived from the durable projection', async t => {
  const h = await harness(t, { events: [{ type: 'assistant/message' }] })
  assert.equal((await h.assemble()).tools.length, 2)
  h.events.push({ type: 'compaction/end' })
  assert.equal((await h.assemble()).tools.length, 1)
  h.events.push({ type: 'assistant/message' })
  assert.equal((await h.assemble()).tools.length, 2)
})

for (const header of [{ delegationDepth: 1 }, { origin: 'subagent' }]) test(`child exclusion ${JSON.stringify(header)}`, async t => {
  const h = await harness(t, { header })
  assert.equal((await h.assemble()).tools.length, 2)
  assert.equal(h.ctx.tools.get('bash', h.agent).description, 'original bash')
  assert.equal((await h.preStep([message('skill-catalog')])).messages.length, 1)
})

test('fork lineage alone is still a root session', async t => {
  const h = await harness(t, { header: { parentSession: 'parent' } })
  assert.equal((await h.assemble()).tools.length, 1)
})

test('disabled events cannot leave stale phase after enabling', async t => {
  const h = await harness(t)
  await h.assemble()
  assert.equal((await h.request('POST', { enabled: false })).status, 200)
  h.events.push({ type: 'assistant/message' })
  await h.request('POST', { enabled: true })
  assert.equal((await h.assemble()).tools.length, 2)
  await h.request('POST', { enabled: false })
  h.events.push({ type: 'compaction/end' })
  await h.request('POST', { enabled: true })
  assert.equal((await h.assemble()).tools.length, 1)
})

test('disable affects future requests and never half of an assembled request', async t => {
  const h = await harness(t)
  await h.assemble()
  await h.request('POST', { enabled: false })
  assert.equal((await h.preStep([message('user'), message('skill-catalog')])).messages.length, 1)
  assert.equal((await h.assemble()).tools.length, 2)
  assert.equal((await h.preStep([message('skill-catalog')])).messages.length, 1)
  assert.equal(JSON.parse(readFileSync(join(h.home, 'plugins/dsh-minimal-first-turn.json'))).enabled, false)
})

test('protected custom complete persona falls back atomically with original tool implementation', async t => {
  const h = await harness(t, { complete: 'Protected custom persona' })
  const assembly = await h.assemble()
  assert.deepEqual(assembly.sections.map(section => section.text), ['Protected custom persona'])
  assert.equal(assembly.tools.length, 2)
  assert.equal(assembly.contexts.length, 1)
  assert.equal(h.ctx.tools.get('bash', h.agent).description, 'original bash')
  assert.equal((await h.preStep([message('agent-instructions')])).messages.length, 1)
})

test('official Minimal complete persona remains compatible', async t => {
  const h = await harness(t, { complete: persona })
  const assembly = await h.assemble()
  assert.deepEqual(assembly.sections.map(section => section.text), [persona])
  assert.equal(assembly.tools.length, 1)
})

test('failed persistence leaves memory unchanged', async t => {
  const h = await harness(t, { badPath: true })
  assert.equal((await h.request('POST', { enabled: false })).status, 500)
  assert.deepEqual(await h.request(), { status: 200, body: { enabled: true } })
})

test('state endpoint honors Connection rejection and validates content type, JSON and size', async t => {
  const h = await harness(t)
  for (const [body, headers, expected] of [
    [{ enabled: false }, { cookie: 'unauthenticated' }, 401],
    [{ enabled: false }, { origin: 'https://attacker.example' }, 403],
    [{ enabled: false }, { 'sec-fetch-site': 'cross-site' }, 403],
    [{ enabled: false }, { origin: 'null' }, 403],
    [{ enabled: false }, { 'content-type': 'text/plain' }, 415],
    ['{', {}, 400], [{ enabled: 'false' }, {}, 400], ['x'.repeat(4097), {}, 413],
  ]) assert.equal((await h.request('POST', body, headers)).status, expected)
  assert.equal((await h.request('DELETE')).status, 405)
  assert.deepEqual((await h.request()).body, { enabled: true })
})

test('parallel toggle operations serialize and persist last accepted state', async t => {
  const h = await harness(t)
  const results = await Promise.all([false, true, false].map(enabled => h.request('POST', { enabled })))
  assert.deepEqual(results.map(result => result.body.enabled), [false, true, false])
  assert.deepEqual((await h.request()).body, { enabled: false })
})

test('plugin unload removes agent-owned tools', async t => {
  const h = await harness(t)
  await h.assemble()
  await h.fiber.dispose()
  assert.equal(h.ctx.tools.get('bash', h.agent).description, 'original bash')
})

test('rejected first step does not promote the next request', async t => {
  const h = await harness(t)
  await h.assemble()
  const original = [message('agent-instructions')]
  assert.deepEqual(await h.preStep(original, 'reject'), { kind: 'reject', messages: original })
  assert.equal((await h.assemble()).tools.length, 1)
})

test('agent-local Bash collision cleans partial startup and falls back without filtering', async t => {
  const h = await harness(t)
  await h.agent.ctx.plugin({ inject: ['tools'], apply: context => {
    context.tools.register({
      name: 'bash', description: 'agent-specific Bash', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'agent Bash',
    })
  } })
  const assembly = await h.assemble()
  assert.equal(assembly.tools.length, 2)
  assert.equal(h.ctx.tools.get('bash', h.agent).description, 'agent-specific Bash')
  assert.equal((await h.preStep([message('skill-catalog')])).messages.length, 1)
})

test('current SessionProjectionRegistry replays history without session.events and observes compaction', async t => {
  const { Session } = await import('@deepseek-ai/dsh-session')
  const { default: Projections } = await import('@deepseek-ai/dsh-session-projection')
  const ctx = new Context()
  await ctx.plugin(Projections)
  ctx.sessionProjections.register(plugin.phaseProjection)
  t.after(() => ctx.fiber.dispose())
  const source = Session.create('source')
  const seed = [source.append('tool/call', { turn: 1, step: 1, callId: 'call', name: 'bash', arguments: '{}' })]
  const resumed = Session.create('resumed', seed)
  assert.equal(resumed.events, undefined)
  assert.deepEqual(ctx.sessionProjections.stateOf(resumed, plugin.phaseProjection.key), { promoted: true, deferred: [] })
  resumed.append('compaction/end', {})
  assert.deepEqual(ctx.sessionProjections.stateOf(resumed, plugin.phaseProjection.key), { promoted: false, deferred: [] })
  resumed.append('tool/call', { turn: 2, step: 1, callId: 'call-2', name: 'bash', arguments: '{}' })
  assert.deepEqual(ctx.sessionProjections.stateOf(resumed, plugin.phaseProjection.key), { promoted: true, deferred: [] })
})

test('saved disabled state is honored on startup without mounting tools', async t => {
  const h = await harness(t, { initialEnabled: false })
  assert.deepEqual((await h.request()).body, { enabled: false })
  assert.equal((await h.assemble()).tools.length, 2)
  assert.equal(h.ctx.tools.get('bash', h.agent).description, 'original bash')
})

test('suppressed combined baseline/nested updates return before provider reconciliation', async t => {
  const h = await harness(t)
  const nested = { id: 'nested-1', role: 'user', content: [{ type: 'text', text: 'nested instructions' }], source: { kind: 'agent-instructions', baseline: true, changes: [{ action: 'set', scope: '/nested', path: '/nested/AGENTS.md' }] } }
  await h.assemble()
  assert.deepEqual((await h.preStep([message('user'), nested])).messages, [message('user')])
  // Failed/empty model output leaves the phase minimal. The next provider must
  // still observe the pending nested scope, with no duplicate accumulation.
  let observed = []
  h.ctx.on('agent/pre-step', async ({ messages }, next) => { observed = [...messages]; return next() })
  await h.assemble()
  assert.deepEqual((await h.preStep([message('user')])).messages, [message('user')])
  assert.equal(observed.filter(item => item === nested).length, 1)
  h.events.push({ type: 'assistant/message' })
  await h.assemble()
  const restored = await h.preStep([message('user')])
  assert.equal(observed[0], nested)
  assert.equal(restored.messages[0], nested)
  h.events.push({ type: 'user/message', data: nested })
  assert.equal((await h.preStep([message('user')])).messages.length, 1)
})

test('restart and partial user-message commits preserve exactly the undelivered instruction updates', async t => {
  const first = await harness(t)
  const instruction = suffix => ({
    id: `instruction-${suffix}`, role: 'user', content: [{ type: 'text', text: suffix }],
    source: { kind: 'agent-instructions', baseline: true, changes: [{ action: 'set', scope: `/${suffix}`, path: `/${suffix}/AGENTS.md` }] },
  })
  const a = instruction('a'), b = instruction('b')
  await first.assemble()
  await first.preStep([message('user'), a, b])
  first.events.push({ type: 'assistant/message' })
  const resumed = await harness(t, { events: JSON.parse(JSON.stringify(first.events)) })
  assert.equal((await resumed.assemble()).tools.length, 2)
  const restored = await resumed.preStep([message('user')])
  assert.deepEqual(restored.messages.slice(0, 2), [a, b])
  // A crash after proposing delivery but before committing must replay both.
  const proposed = await harness(t, { events: JSON.parse(JSON.stringify(resumed.events)) })
  await proposed.assemble()
  assert.deepEqual((await proposed.preStep([message('user')])).messages.slice(0, 2), [a, b])
  proposed.events.push({ type: 'user/message', data: a })
  const partial = await harness(t, { events: JSON.parse(JSON.stringify(proposed.events)) })
  await partial.assemble()
  assert.deepEqual((await partial.preStep([message('user')])).messages, [b, message('user')])
})

test('real Session replay preserves deferred instruction event and clears only committed IDs', async t => {
  const { Session } = await import('@deepseek-ai/dsh-session')
  const { default: Projections } = await import('@deepseek-ai/dsh-session-projection')
  const ctx = new Context()
  await ctx.plugin(Projections)
  ctx.sessionProjections.register(plugin.phaseProjection)
  t.after(() => ctx.fiber.dispose())
  const original = Session.create('original-deferred')
  const instruction = message('agent-instructions')
  const seed = [original.append('minimal-first-turn/deferred-instructions', { messages: [instruction] })]
  const resumed = Session.create('resumed-deferred', JSON.parse(JSON.stringify(seed)))
  assert.equal(plugin.phaseProjection.stateSchema.safeParse(ctx.sessionProjections.stateOf(resumed, plugin.phaseProjection.key)).success, true)
  assert.deepEqual(ctx.sessionProjections.stateOf(resumed, plugin.phaseProjection.key).deferred, [instruction])
  resumed.append('user/message', instruction, { surfaceOp: 'append' })
  assert.deepEqual(ctx.sessionProjections.stateOf(resumed, plugin.phaseProjection.key).deferred, [])
})
