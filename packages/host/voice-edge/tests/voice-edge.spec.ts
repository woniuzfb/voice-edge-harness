/**
 * REAL-composition coverage: webserver + session + agent + tools + voice-edge
 * booted through the vendored Loader, with a stub agent factory standing in
 * for the agent-loop provider. Assertions observe the HTTP surface and the
 * durable session log the bridge writes.
 */

import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, AgentSetup } from '@deepseek-ai/dsh-agent'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as VoiceEdge from '../src/index.ts'

const TOKEN = 'test-secret'
let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Session id derivation, mirrored from the plugin for lookups. */
function sessionIdFor(conversationKey: string): SessionId {
  return SessionId(`voice-edge-${createHash('sha256').update(conversationKey).digest('hex')}`)
}

/**
 * Boot the composition and install a stub agent factory plus one global echo
 * tool. The factory builds a store-entered session and a minimal Agent, the
 * same shape the agent-loop factory publishes, including the unpublished
 * `setup(agentCtx)` contract this spec exercises through the preset path.
 *
 * `options.roster` composes a stub `agentPresets` roster whose mount installs
 * one scoped tool on the joining agent, standing in for a preset composition;
 * `options.preset` additionally names one in the plugin config.
 * `options.persist` composes the JSONL persistence backend rooted at that
 * directory (reusing a directory across two boots simulates a restart).
 */
async function boot(options: { roster?: boolean; preset?: string; persist?: string } = {}): Promise<Context> {
  root = options.persist ?? await mkdtemp(join(tmpdir(), 'dsh-voice-edge-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    ...options.persist === undefined ? [] : [
      "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
      '  config:',
      `    root: ${options.persist}`,
    ],
    "- name: '@deepseek-ai/dsh-voice-edge'",
    '  config:',
    `    token: ${TOKEN}`,
    ...options.preset === undefined ? [] : [`    preset: ${options.preset}`],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlPersistence],
    ['@deepseek-ai/dsh-voice-edge', VoiceEdge],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()

  if (options.roster === true) {
    ctx.provide('agentPresets', {
      defaultId: 'standard',
      resolve: (id?: string) => {
        if (id !== undefined && id !== 'standard' && id !== 'voice') {
          return Promise.reject(new Error(`unknown preset ${id}`))
        }
        return Promise.resolve({ id: id ?? 'standard' })
      },
      mount: (agentCtx: Context, id?: string) => {
        // A real preset composition is a Loader plugin declaring its own
        // injects; a scoped plugin on the joining agent is the stub's stand-in.
        agentCtx.plugin({
          inject: ['tools'],
          apply(scoped: Context) {
            scoped.tools.register(defineTool({
              name: 've_preset_tool',
              description: 'Tool only the preset composition provides.',
              parameters: {},
              output: {
                schema: { type: 'object', additionalProperties: false, properties: {} },
                render: () => [],
              },
              execute: () => Promise.resolve({}),
            }))
          },
        })
        return Promise.resolve({ id: id ?? 'standard' })
      },
    } as never)
  }

  /** Build one minimal Agent on a live session, run setup, register, and return the handle. */
  async function publishAgent(session: Session, setup: AgentSetup | undefined): Promise<AgentHandle> {
    const scope = ctx.plugin(() => {})
    const agent: Agent = {
      id: session.id,
      options: {},
      session,
      inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
      status: 'idle',
      ctx: scope.ctx,
      followup: () => {},
      steer: () => {},
      inject: () => {},
      send: () => {},
      cancel() {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    // The unpublished-setup contract the real factory runs: setup composes
    // the scoped world before registration, so its throw rolls creation back.
    await setup?.(agent.ctx)
    const unregister = ctx.agents.register(agent)
    return {
      agent,
      dispose: () => {
        unregister()
        return Promise.resolve()
      },
    }
  }

  ctx.agents.setFactory({
    async createAgent(_ownerCtx, options) {
      // The stub binds to the composition root (the real agent-loop factory
      // carries its own dependency origin); ownerCtx only scopes ownership.
      const session = ctx.sessions.create(options.sessionId, {
        meta: {
          cwd: options.meta?.cwd ?? process.cwd(),
          ...options.meta?.agentPreset === undefined ? {} : { agentPreset: options.meta.agentPreset },
        },
      })
      return publishAgent(session, options.setup)
    },
    async resume(_ownerCtx, options) {
      // The real factory reconstructs through persistence.prepare(); the stub
      // replays the loaded log as a creation seed — same published shape.
      const persistence = ctx.get('sessionPersistence')
      if (persistence === undefined) throw new Error('stub factory resume requires a persistence backend')
      const loaded = await persistence.load(options.resumeSessionId)
      const session = ctx.sessions.create(options.resumeSessionId, {
        seed: loaded.events,
        meta: {
          ...loaded.meta.cwd === undefined ? {} : { cwd: loaded.meta.cwd },
          ...loaded.meta.agentPreset === undefined ? {} : { agentPreset: loaded.meta.agentPreset },
        },
      })
      return publishAgent(session, options.setup)
    },
  })

  ctx.tools.register(defineTool({
    name: 've_echo',
    description: 'Echo the input text back.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to echo.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `echo: ${value.text}` }],
    },
    execute(args) {
      return Promise.resolve({ text: args.text })
    },
  }))
  return ctx
}

/** POST one JSON body to the bridge, returning status and parsed payload. */
async function post(
  ctx: Context,
  sub: string,
  body: unknown,
  token: string | null = TOKEN,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}/api/voice-edge${sub}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...token === null ? {} : { authorization: `Bearer ${token}` },
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, payload: await response.json() as Record<string, unknown> }
}

/** Find the mirrored session for a conversation key. */
function sessionOf(ctx: Context, conversationKey: string): Session {
  const session = ctx.sessions.get(sessionIdFor(conversationKey))
  if (session === undefined) throw new Error(`no session for ${conversationKey}`)
  return session
}

describe('voice-edge bridge over a real Loader composition', () => {
  it('rejects requests without the bearer token', async () => {
    const ctx = await boot()
    const denied = await post(ctx, '/session/sync', { conversation_key: 'k1' }, null)
    expect(denied.status).toBe(401)
    expect((denied.payload['error'] as { type: string }).type).toBe('unauthorized')
  }, 30_000)

  it('sync binds a conversation, mirrors history, and returns Harness tool schemas', async () => {
    const ctx = await boot()
    const synced = await post(ctx, '/session/sync', {
      conversation_key: 'conv-1',
      boot_key: 'conv-1',
      request_id: 'req-1',
      model: 'LLM:m365-claude-opus',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
    })
    expect(synced.status).toBe(200)
    expect(synced.payload['synced']).toBe(true)
    expect(synced.payload['conversation_key']).toBe('conv-1')
    expect(String(synced.payload['harness_session_id'])).toMatch(/^voice-edge-/)
    const tools = synced.payload['tools'] as { name: string }[]
    expect(tools.map(tool => tool.name)).toContain('ve_echo')

    const events = sessionOf(ctx, 'conv-1').events
    const syncEvent = events.find(event => event.type === 'voice-edge/sync')
    expect(syncEvent?.data.model).toBe('LLM:m365-claude-opus')
    expect(syncEvent?.data.messageCount).toBe(2)
  }, 30_000)

  it('maps a later full key onto the boot-key session (no duplicate session)', async () => {
    const ctx = await boot()
    const first = await post(ctx, '/session/sync', { boot_key: 'boot-1', model: 'm' })
    const second = await post(ctx, '/session/sync', { boot_key: 'boot-1', full_key: 'full-1', model: 'm' })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.payload['harness_session_id']).toBe(first.payload['harness_session_id'])
    expect(second.payload['conversation_key']).toBe(first.payload['conversation_key'])
  }, 30_000)

  it('mirrors model events into the bound session only', async () => {
    const ctx = await boot()
    await post(ctx, '/session/sync', { conversation_key: 'conv-2', model: 'm' })
    const mirrored = await post(ctx, '/model/event', {
      conversation_key: 'conv-2',
      sequence: 1,
      kind: 'step',
      text: 'assistant text',
      tool_calls: [{ id: 'c1', name: 've_echo', arguments: '{"text":"hi"}' }],
      finish_reason: 'tool_calls',
    })
    expect(mirrored.status).toBe(200)
    const event = sessionOf(ctx, 'conv-2').events.find(e => e.type === 'voice-edge/model-event')
    expect(event?.data.kind).toBe('step')
    expect(event?.data.text).toBe('assistant text')
    expect(event?.data.toolCalls).toHaveLength(1)

    const unknown = await post(ctx, '/model/event', { conversation_key: 'nope', kind: 'step' })
    expect(unknown.status).toBe(409)
  }, 30_000)

  it('executes a Harness tool as the conversation agent and logs the pair', async () => {
    const ctx = await boot()
    await post(ctx, '/session/sync', { conversation_key: 'conv-3', model: 'm' })
    const executed = await post(ctx, '/tool/execute', {
      conversation_key: 'conv-3',
      call_id: 'call-1',
      name: 've_echo',
      arguments: { text: 'hello harness' },
    })
    expect(executed.status).toBe(200)
    const result = executed.payload['tool_result'] as { isError: boolean; text: string }
    expect(result.isError).toBe(false)
    expect(result.text).toBe('echo: hello harness')

    const events = sessionOf(ctx, 'conv-3').events
    const call = events.find(event => event.type === 'voice-edge/tool-call')
    const outcome = events.find(event => event.type === 'voice-edge/tool-result')
    expect(call?.data.callId).toBe('call-1')
    expect(outcome?.data.isError).toBe(false)
    expect(outcome?.data.text).toBe('echo: hello harness')
  }, 30_000)

  it('turn/finish appends the finish marker and flushes', async () => {
    const ctx = await boot()
    await post(ctx, '/session/sync', { conversation_key: 'conv-4', model: 'm' })
    const finished = await post(ctx, '/turn/finish', { conversation_key: 'conv-4', sequence: 7, status: 'completed' })
    expect(finished.status).toBe(200)
    expect(finished.payload['synced']).toBe(true)
    // No persistence backend in this composition: the checkpoint ran, but no
    // durability listener participated.
    expect(finished.payload['flushed']).toBe(false)
    const event = sessionOf(ctx, 'conv-4').events.find(e => e.type === 'voice-edge/finish')
    expect(event?.data.sequence).toBe(7)
    expect(event?.data.status).toBe('completed')
  }, 30_000)

  it('joins every conversation agent to the configured preset when a roster is composed', async () => {
    const ctx = await boot({ roster: true, preset: 'voice' })
    const synced = await post(ctx, '/session/sync', { conversation_key: 'conv-5', model: 'm' })
    expect(synced.status).toBe(200)
    const tools = synced.payload['tools'] as { name: string }[]
    // The preset composition's tool joins the global layer's tool: the agent
    // sees both, so a preset roster no longer blanks the bridge's tool catalog.
    expect(tools.map(tool => tool.name)).toContain('ve_echo')
    expect(tools.map(tool => tool.name)).toContain('ve_preset_tool')
    expect(sessionOf(ctx, 'conv-5').header.agentPreset).toBe('voice')
  }, 30_000)

  it('joins the roster default when no preset is configured', async () => {
    const ctx = await boot({ roster: true })
    await post(ctx, '/session/sync', { conversation_key: 'conv-6', model: 'm' })
    expect(sessionOf(ctx, 'conv-6').header.agentPreset).toBe('standard')
  }, 30_000)

  it('answers 503 when the configured preset is unknown to the roster', async () => {
    const ctx = await boot({ roster: true, preset: 'missing' })
    const failed = await post(ctx, '/session/sync', { conversation_key: 'conv-7', model: 'm' })
    expect(failed.status).toBe(503)
    expect((failed.payload['error'] as { type: string }).type).toBe('agent_unavailable')
  }, 30_000)

  it('adopts the persisted turn-1 session after a restart instead of splitting or losing the turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-voice-edge-restart-'))
    // Turn 1 binds by boot key alone (no assistant reply exists yet).
    let ctx = await boot({ persist: dir })
    const first = await post(ctx, '/session/sync', { conversation_key: 'boot-K', boot_key: 'boot-K', model: 'm' })
    expect(first.status).toBe(200)
    await post(ctx, '/turn/finish', { conversation_key: 'boot-K' })
    await ctx.fiber.dispose()

    // "Restart": same durable root, empty in-memory alias tables. Turn 2
    // arrives claiming the strong full key while still presenting the boot key.
    ctx = await boot({ persist: dir })
    const second = await post(ctx, '/session/sync', {
      conversation_key: 'full-K',
      boot_key: 'boot-K',
      full_key: 'full-K',
      model: 'm',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
    })
    expect(second.status).toBe(200)
    // The turn-1 session was resumed, not re-created: one conversation, one id.
    expect(second.payload['harness_session_id']).toBe(first.payload['harness_session_id'])
    expect(ctx.sessions.list().filter(s => s.id.startsWith('voice-edge-'))).toHaveLength(1)

    // Turn-2 events land on the adopted session and the finish flushes
    // durably — the pre-fix behavior here was a fresh same-id session whose
    // materialization the backend rejects, failing the whole turn with 500.
    await post(ctx, '/model/event', { conversation_key: 'full-K', sequence: 1, kind: 'step', text: 'second turn' })
    const finish = await post(ctx, '/turn/finish', { conversation_key: 'full-K' })
    expect(finish.status).toBe(200)
    expect(finish.payload['flushed']).toBe(true)
    const adopted = ctx.sessions.get(SessionId(String(second.payload['harness_session_id'])))
    expect(adopted?.events.filter(event => event.type === 'voice-edge/sync')).toHaveLength(2)
  }, 60_000)
})
