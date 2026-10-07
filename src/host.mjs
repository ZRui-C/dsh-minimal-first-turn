import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { z } from 'zod'

import TerminalSessionService from '@deepseek-ai/dsh-terminal'
import * as terminalBash from '@deepseek-ai/dsh-terminal-bash'
import * as persistentBash from '@deepseek-ai/dsh-tool-bash-persistent'

const PLUGIN_ID = 'dsh-minimal-first-turn'
const SUPPRESSED_SOURCES = new Set(['agent-instructions', 'skill-catalog'])
const MINIMAL_PERSONA = 'You are a helpful software engineer assistant.'
const STATE_ENDPOINT = '/minimal-first-turn/state'
// Private per-assembly marker: never bypass other plugins' assembly hooks.
const ASSEMBLY_MODE = Symbol('minimal-first-turn assembly')

export const name = PLUGIN_ID
export const inject = ['agents', 'webServer', 'systemPrompt', 'sessionProjections', 'connection']

const PERSISTENT_BASH_DESCRIPTION = [
  'Run commands in a bash shell',
  '* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.',
  '* Network access depends on the task environment. Prefer configured mirrors/proxies when they are available.',
  '* State is persistent across command calls and discussions with the user.',
  "* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.",
  '* Please avoid commands that may produce a very large amount of output.',
  "* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.",
].join('\n')

function statePath() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'plugins', `${PLUGIN_ID}.json`)
}

function readState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed?.enabled === 'boolean' ? parsed.enabled : true
  } catch {
    return true
  }
}

function persistState(path, enabled) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify({ enabled }, null, 2)}\n`, 'utf8')
  renameSync(temp, path)
}

export function isRootAgent(agent) {
  const header = agent?.session?.header
  return header !== undefined && header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0
}

const DEFERRED_EVENT = 'minimal-first-turn/deferred-instructions'
const deferredMessageSchema = z.object({
  id: z.string().min(1),
  role: z.literal('user'),
  source: z.object({ kind: z.literal('agent-instructions') }).passthrough(),
  content: z.array(z.unknown()),
}).passthrough()

export const phaseProjection = {
  key: 'minimalFirstTurn',
  stateVersion: 2,
  stateSchema: z.object({ promoted: z.boolean(), deferred: z.array(deferredMessageSchema) }),
  init: () => ({ promoted: false, deferred: [] }),
  apply: (state, event) => {
    if (event.type === 'compaction/end') return { ...state, promoted: false }
    if (event.type === 'tool/call' || event.type === 'assistant/message') return { ...state, promoted: true }
    if (event.type === DEFERRED_EVENT) return { ...state, deferred: event.data.messages }
    if (event.type === 'user/message' && state.deferred.some(message => message.id === event.data.id)) {
      return { ...state, deferred: state.deferred.filter(message => message.id !== event.data.id) }
    }
    return state
  },
}

function createBootstrapPlugin() {
  return {
    name: 'minimal-first-turn-bash',
    async apply(agentCtx) {
      const bootstrapCtx = agentCtx.isolate('terminals')
      await bootstrapCtx.plugin(TerminalSessionService)
      await bootstrapCtx.plugin(terminalBash, { timeoutMs: 300000 })
      // The official tool obtains cwd from owner.session.header.cwd.
      await bootstrapCtx.plugin(persistentBash, {
        timeoutMs: 300000,
        description: PERSISTENT_BASH_DESCRIPTION,
      })
    },
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req) {
  let raw = ''
  let size = 0
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk)
    if (size > 4096) throw Object.assign(new Error('request body too large'), { status: 413 })
    raw += chunk
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 })
  }
}

export function apply(ctx) {
  ctx.sessionProjections.register(phaseProjection)
  const path = statePath()
  let enabled = readState(path)
  let revision = 0
  let updateQueue = Promise.resolve()
  let disposed = false
  const mounts = new Map()
  const requestMinimal = new WeakMap()
  const warned = new Set()

  const warnOnce = (key, message) => {
    if (warned.has(key)) return
    warned.add(key)
    ctx.logger.warn(`${PLUGIN_ID}: ${message}`)
  }

  const deferredFor = agent => ctx.sessionProjections.stateOf(agent.session, phaseProjection.key)?.deferred ?? []

  const saveDeferred = (agent, messages) => {
    if (JSON.stringify(deferredFor(agent)) === JSON.stringify(messages)) return
    // Non-surface plugin event: durable before any instruction is filtered.
    // It is cleared by committed user/message IDs, never just by proposing a step.
    agent.session.append(DEFERRED_EVENT, { messages })
  }

  const eligible = agent => !disposed && enabled && isRootAgent(agent) && ctx.sessionProjections.stateOf(agent.session, phaseProjection.key)?.promoted === false

  const mountTools = async (agent) => {
    let mount = mounts.get(agent)
    if (mount === undefined) {
      mount = { fiber: undefined, ready: false, promise: undefined }
      mounts.set(agent, mount)
      mount.promise = (async () => {
        try {
          mount.fiber = agent.ctx.plugin(createBootstrapPlugin())
          await mount.fiber
          mount.ready = true
        } catch (error) {
          warnOnce(`mount:${agent.id}`, `Minimal Bash unavailable for agent ${agent.id}: ${String(error?.message ?? error)}`)
        }
      })()
    }
    await mount.promise
    return mount.ready
  }

  const unmountTools = async (agent) => {
    const mount = mounts.get(agent)
    if (mount === undefined) return false
    await mount.promise
    // Do not silently fall back with a half-disposed tool registry.
    await mount.fiber?.dispose()
    mounts.delete(agent)
    return true
  }

  const reassemble = (context, mode) => ctx.systemPrompt.assemble({ ...context, [ASSEMBLY_MODE]: mode })

  // DSH captures providers before invoking the waterfall. Reassemble after
  // mounting/unmounting so the wire schemas and executing definitions agree.
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    if (context[ASSEMBLY_MODE] === 'original') return assembled
    if (context[ASSEMBLY_MODE] === 'minimal') {
      if (!assembled.tools.some(tool => tool.name === 'bash')) return assembled
      return {
        ...assembled,
        sections: [{ name: 'minimal-first-turn:persona', text: MINIMAL_PERSONA }],
        contexts: [],
        tools: assembled.tools.filter(tool => tool.name === 'bash'),
      }
    }

    const agent = context.agent
    if (agent === undefined) return assembled
    requestMinimal.set(agent, false)
    if (!eligible(agent)) {
      return await unmountTools(agent) ? reassemble(context, 'original') : assembled
    }
    const currentRevision = revision
    if (!await mountTools(agent)) {
      await unmountTools(agent)
      return reassemble(context, 'original')
    }
    const minimal = await reassemble(context, 'minimal')
    const compatible = minimal.tools.length === 1 && minimal.tools[0].name === 'bash'
      && minimal.sections.length === 1 && minimal.sections[0].text === MINIMAL_PERSONA
      && minimal.contexts.length === 0
    if (!compatible || currentRevision !== revision || !eligible(agent)) {
      if (!compatible) warnOnce(`catalog:${agent.id}`, `Preset for agent ${agent.id} protects its prompt or does not expose native Bash; leaving its prompt, context, and tools unchanged.`)
      await unmountTools(agent)
      return reassemble(context, 'original')
    }
    requestMinimal.set(agent, true)
    return minimal
  }, { prepend: true })

  ctx.on('agent/pre-step', async (payload, next) => {
    const { agent, messages: claimed } = payload
    const pending = deferredFor(agent)
    // Give DSH's instruction provider its own uncommitted messages back before
    // it reconciles. A baseline may contain one-shot nested-directory changes;
    // dropping it permanently would lose that directory's instructions.
    if (pending.length > 0) {
      const seen = new Set(claimed.map(message => JSON.stringify([message.source, message.content])))
      claimed.unshift(...pending.filter(message => !seen.has(JSON.stringify([message.source, message.content]))))
    }
    const decision = await next()
    if (decision.kind === 'reject' || !Array.isArray(decision.messages)) return decision
    const instructions = decision.messages.filter(message => message?.source?.kind === 'agent-instructions')
    if (pending.length > 0 || requestMinimal.get(agent)) saveDeferred(agent, instructions)
    // This records the assembly actually selected for this request. A toggle
    // changes future assemblies, never half of an already assembled request.
    if (!requestMinimal.get(agent)) return decision
    const messages = decision.messages.filter(message => !SUPPRESSED_SOURCES.has(message?.source?.kind))
    return messages.length === decision.messages.length ? decision : { ...decision, messages }
  }, { prepend: true })

  ctx.on('agent/disposed', ({ agent }) => {
    // Agent-owned fibers have already unwound at this lifecycle boundary.
    mounts.delete(agent)
    requestMinimal.delete(agent)
    warned.delete(`mount:${agent.id}`)
    warned.delete(`catalog:${agent.id}`)
  })

  ctx.effect(() => async () => {
    disposed = true
    // Plugin unload must not leave agent-owned injected tools behind.
    const owners = new Set([...ctx.agents.list(), ...mounts.keys()])
    await Promise.all([...owners].filter(agent => mounts.has(agent) || deferredFor(agent).length > 0).map(async agent => {
      await agent.whenIdle()
      for (const message of deferredFor(agent)) agent.inject(message)
        await unmountTools(agent)
    }))
  }, `${PLUGIN_ID}: agent tools cleanup`)

  const setEnabled = (nextEnabled) => {
    const operation = updateQueue.then(() => {
      if (nextEnabled === enabled) return { enabled }
      // Commit disk first; failed writes leave live behavior unchanged.
      persistState(path, nextEnabled)
      enabled = nextEnabled
      revision++
      return { enabled }
    })
    updateQueue = operation.catch(() => {})
    return operation
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATE_ENDPOINT,
    handler: async (req, res) => {
      // Reuse current DSH Host/Origin fencing AND browser-session auth.
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) return sendJson(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
      if (req.method === 'GET') return sendJson(res, 200, { enabled })
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' })
      if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return sendJson(res, 415, { error: 'content-type must be application/json' })
      }
      try {
        const body = await readJsonBody(req)
        if (body === null || typeof body !== 'object' || typeof body.enabled !== 'boolean') {
          return sendJson(res, 400, { error: 'enabled must be a boolean' })
        }
        return sendJson(res, 200, await setEnabled(body.enabled))
      } catch (error) {
        return sendJson(res, error.status ?? 500, { error: error.status ? error.message : 'could not persist toggle state' })
      }
    },
  }), `${PLUGIN_ID}: state endpoint`)
}
