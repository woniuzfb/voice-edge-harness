/**
 * Voice Edge bridge plugin. Exposes a token-authenticated HTTP API under
 * `config.path` (default `/api/voice-edge`) on the composed `webServer`
 * service so an external voice_edge.py process can:
 *
 *   1. bind one of its conversations to a Harness session (`session/sync`),
 *      receiving the Harness tool schemas visible to that session's agent;
 *   2. mirror external model steps into the session log (`model/event`);
 *   3. execute Harness tools as that agent (`tool/execute`);
 *   4. close the turn and force a durability checkpoint (`turn/finish`).
 *
 * Boundary contract: the plugin never returns model context (no messages, no
 * system prompt, no assembled history) — voice_edge.py remains the sole owner
 * of the model request and of the client-visible output. The Harness agent
 * created per conversation is a scope and session container only; the plugin
 * never submits inbox work, so its loop never runs a model.
 * @module @deepseek-ai/dsh-voice-edge
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
// Type-only edges: resolve the `webServer` and `agentPresets` Context service
// merges and the `approval/request` Events merge this plugin consumes.
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {
  VoiceEdgeAck,
  VoiceEdgeError,
  VoiceEdgeMessageProjection,
  VoiceEdgeModelEventRequest,
  VoiceEdgeSyncRequest,
  VoiceEdgeToolExecuteRequest,
  VoiceEdgeToolResult,
  VoiceEdgeTurnFinishRequest,
} from './types.ts'

export type * from './types.ts'

export const name = 'voice-edge'
export const inject = ['webServer', 'agents', 'tools', 'sessions']

/** Plugin configuration. The token is the only required value. */
export interface Config {
  /** Absolute route prefix the API is mounted under. */
  path: string
  /** Shared secret voice_edge.py presents as `Authorization: Bearer`. */
  token: string
  /**
   * Answer `approval/request` for voice-edge-owned agents with
   * `allowed-once`. Voice Edge turns are non-interactive — there is no user
   * at this bridge to answer an ask — so a policy of `ask` would otherwise
   * fail closed and deny every guarded tool.
   */
  autoApprove: boolean
  /** Fallback working directory for created agents (request `cwd` wins). */
  cwd?: string
  /**
   * Agent preset every created conversation joins, overriding the roster
   * default. Ignored when no `agentPresets` service is composed — such
   * deployments (e.g. the base-only profile) expose model-facing tools in the
   * host layer, where every agent already sees them.
   */
  preset?: string
  /** Request body cap in bytes. */
  maxBodyBytes: number
  /** Wall-clock budget for one tool execution. */
  toolTimeoutMs: number
  /** Bound on live conversations; least-recently-used are disposed. */
  maxConversations: number
}

/** Schemastery configuration for the voice-edge bridge. */
export const Config: z<Config> = z.object({
  path: z.string().default('/api/voice-edge'),
  token: z.string().required(),
  autoApprove: z.boolean().default(true),
  cwd: z.string(),
  preset: z.string(),
  maxBodyBytes: z.natural().default(8 * 1024 * 1024),
  toolTimeoutMs: z.natural().default(120_000),
  maxConversations: z.natural().default(256),
})

/** One voice-edge conversation bound to its Harness agent/session. */
interface Conversation {
  /** Canonical conversation key (full key when known, else boot key). */
  key: string
  sessionId: SessionId
  agent: Agent
  /** Present when this plugin created the agent (ownership to dispose). */
  handle?: AgentHandle
  /** Last sequence handed out for ordering responses. */
  sequence: number
  /** Serializes tool executions so log pairs never interleave. */
  chain: Promise<unknown>
  touched: number
}

/** Error carrying the HTTP status the handler should answer with. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly type = 'voice_edge_error',
  ) {
    super(message)
  }
}

/** Per-message mirror caps: the sync event is diagnostic, not a datastore. */
const SYNC_MAX_MESSAGES = 50
const SYNC_MAX_MESSAGE_CHARS = 4000
/** Model-event text mirror caps. */
const EVENT_MAX_TEXT_CHARS = 16_000

/** Flatten result content blocks into model-facing text for the wire. */
function flattenContent(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') {
      parts.push(block.text)
    } else {
      parts.push(JSON.stringify(block))
    }
  }
  return parts.join('\n')
}

/** Coerce an unknown value to a trimmed string, or '' when absent. */
function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Truncate a mirrored text field. */
function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Stable session identity for a conversation key; the raw key never leaves the process. */
function sessionIdFor(conversationKey: string): SessionId {
  const digest = createHash('sha256').update(conversationKey).digest('hex')
  return SessionId(`voice-edge-${digest}`)
}

/**
 * Bound a client message history to the bounded sync projection. Only
 * role/name/flattened text survive; anything unrecognizable is skipped.
 */
function projectMessages(messages: unknown): VoiceEdgeMessageProjection[] {
  if (!Array.isArray(messages)) return []
  const projected: VoiceEdgeMessageProjection[] = []
  for (const raw of messages.slice(-SYNC_MAX_MESSAGES)) {
    if (typeof raw !== 'object' || raw === null) continue
    const message = raw as Record<string, unknown>
    const role = asString(message['role']) || 'unknown'
    const name = asString(message['name'])
    const content = message['content']
    let text = ''
    if (typeof content === 'string') {
      text = content
    } else if (Array.isArray(content)) {
      text = content
        .map(part => (typeof part === 'object' && part !== null
          ? asString((part as Record<string, unknown>)['text'])
          : ''))
        .filter(Boolean)
        .join('\n')
    }
    projected.push({ role, ...name ? { name } : {}, text: cap(text, SYNC_MAX_MESSAGE_CHARS) })
  }
  return projected
}

/** Register the HTTP surface and conversation registry. */
export function apply(ctx: Context, config: Config): void {
  if (!config.token) throw new Error('voice-edge: config.token must be a non-empty shared secret')
  const base = config.path.replace(/\/+$/, '') || '/'
  const conversations = new Map<string, Conversation>()
  /** boot/full/conversation key aliases -> canonical conversation key. */
  const aliases = new Map<string, string>()
  /** sessionId -> conversation, for the approval answerer. */
  const bySessionId = new Map<string, Conversation>()
  const expectedAuth = Buffer.from(`Bearer ${config.token}`)

  /** Constant-time bearer check; the token is the whole trust boundary. */
  function authorized(req: IncomingMessage): boolean {
    const presented = Buffer.from(req.headers['authorization'] ?? '')
    return presented.length === expectedAuth.length && timingSafeEqual(presented, expectedAuth)
  }

  function send(res: ServerResponse, status: number, payload: VoiceEdgeAck | VoiceEdgeError | object): void {
    const body = JSON.stringify(payload)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(body)
  }

  /** Read and parse a JSON request body under the configured cap. */
  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const buf = chunk as Buffer
      size += buf.length
      if (size > config.maxBodyBytes) throw new HttpError(413, 'request body too large', 'body_too_large')
      chunks.push(buf)
    }
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('not an object')
      }
      return parsed as Record<string, unknown>
    } catch {
      throw new HttpError(400, 'request body must be a JSON object', 'bad_json')
    }
  }

  /** Resolve an existing conversation through any known alias. */
  function lookup(keys: readonly string[]): Conversation | undefined {
    for (const key of keys) {
      if (!key) continue
      const canonical = aliases.get(key)
      const convo = canonical === undefined ? conversations.get(key) : conversations.get(canonical)
      if (convo !== undefined) return convo
    }
    return undefined
  }

  /** Evict least-recently-used conversations beyond the configured bound. */
  async function evict(): Promise<void> {
    while (conversations.size > config.maxConversations) {
      let oldest: Conversation | undefined
      for (const convo of conversations.values()) {
        if (oldest === undefined || convo.touched < oldest.touched) oldest = convo
      }
      if (oldest === undefined) return
      conversations.delete(oldest.key)
      bySessionId.delete(oldest.sessionId)
      for (const [alias, target] of aliases) {
        if (target === oldest.key) aliases.delete(alias)
      }
      await oldest.handle?.dispose()
    }
  }

  /**
   * Create the Harness agent for a canonical conversation key, or resume the
   * persisted session this conversation already owns. A restart empties the
   * in-memory alias tables, so a later sync's lookup misses; probing the
   * durable store for the claimed key's session (a continuation) or the boot
   * key's (the turn-1 mirror) and resuming it keeps one conversation on one
   * session. Creating a same-id fresh session instead would desynchronize the
   * in-memory log from the durable one, and the persistence backend rejects
   * the mismatched materialization at the next flush — losing the whole turn.
   */
  async function createConversation(key: string, bootKey: string, cwd: string | undefined): Promise<Conversation> {
    const sessionId = sessionIdFor(key)
    const existing = ctx.agents.get(sessionId)
    if (existing !== undefined) {
      return { key, sessionId, agent: existing, sequence: 0, chain: Promise.resolve(), touched: Date.now() }
    }
    let resumeSessionId: SessionId | undefined
    const persistence = ctx.get('sessionPersistence')
    if (persistence !== undefined) {
      // Same first-user-line boot collision semantics as the in-memory alias:
      // the boot probe may adopt another conversation's session exactly where
      // the pre-restart alias lookup would have merged them too.
      const candidates = [sessionId, ...bootKey !== '' && bootKey !== key ? [sessionIdFor(bootKey)] : []]
      const headers = await persistence.list()
      resumeSessionId = candidates.find(id => headers.some(header => header.id === id))
    }
    let handle: AgentHandle
    try {
      const presets = ctx.get('agentPresets')
      const workingDir = cwd ?? config.cwd ?? process.cwd()
      if (presets === undefined) {
        handle = resumeSessionId !== undefined
          ? await ctx.agents.resume({ resumeSessionId })
          : await ctx.agents.create({ sessionId, meta: { cwd: workingDir } })
      } else {
        // Resolve BEFORE the lifecycle call: the session boundary snapshots
        // meta before setup runs, and a preset mount failure inside setup
        // rolls the whole creation back rather than publishing a
        // half-composed agent. Resume rebuilds the same scoped world on the
        // persisted session (its header already carries the preset id).
        const preset = await presets.resolve(config.preset)
        const setup = async (agentCtx: Context) => void await presets.mount(agentCtx, preset.id)
        handle = resumeSessionId !== undefined
          ? await ctx.agents.resume({ resumeSessionId, setup })
          : await ctx.agents.create({
            sessionId,
            meta: { cwd: workingDir, agentPreset: preset.id },
            setup,
          })
      }
    } catch (error) {
      throw new HttpError(
        503,
        `voice-edge: cannot create Harness agent (${error instanceof Error ? error.message : String(error)})`,
        'agent_unavailable',
      )
    }
    return {
      key,
      sessionId: resumeSessionId ?? sessionId,
      agent: handle.agent,
      handle,
      sequence: 0,
      chain: Promise.resolve(),
      touched: Date.now(),
    }
  }

  /** POST {base}/session/sync — bind a conversation, mirror the history, return tool schemas. */
  async function onSync(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const request = body as unknown as VoiceEdgeSyncRequest
    const bootKey = asString(request.boot_key)
    const fullKey = asString(request.full_key)
    const claimed = asString(request.conversation_key)
    const key = claimed || fullKey || bootKey
    if (!key) throw new HttpError(400, 'conversation_key (or boot_key/full_key) is required', 'missing_key')
    let convo = lookup([claimed, fullKey, bootKey])
    convo ??= await createConversation(key, bootKey, asString(request.cwd) || undefined)
    convo.touched = Date.now()
    conversations.set(convo.key, convo)
    bySessionId.set(convo.sessionId, convo)
    for (const alias of new Set([key, claimed, fullKey, bootKey].filter(Boolean))) {
      aliases.set(alias, convo.key)
    }
    await evict()
    convo.sequence += 1
    const messages = Array.isArray(request.messages) ? request.messages : []
    convo.agent.session.append('voice-edge/sync', {
      requestId: asString(request.request_id),
      model: asString(request.model),
      messageCount: messages.length,
      messages: projectMessages(messages),
      ...bootKey ? { bootKey } : {},
      ...fullKey ? { fullKey } : {},
    })
    const tools: ToolSchema[] = ctx.tools.schemas(convo.agent)
    send(res, 200, {
      conversation_key: convo.key,
      harness_session_id: convo.sessionId,
      synced: true,
      sequence: convo.sequence,
      tools,
    } satisfies VoiceEdgeAck & { tools: ToolSchema[] })
  }

  /** Resolve the conversation or fail the request. */
  function requireConversation(body: Record<string, unknown>): Conversation {
    const key = asString(body['conversation_key'])
    if (!key) throw new HttpError(400, 'conversation_key is required', 'missing_key')
    const convo = lookup([key])
    if (convo === undefined) {
      throw new HttpError(409, `unknown conversation_key ${JSON.stringify(key)} — call session/sync first`, 'unknown_conversation')
    }
    convo.touched = Date.now()
    return convo
  }

  /** POST {base}/model/event — mirror one external model step. */
  function onModelEvent(body: Record<string, unknown>, res: ServerResponse): void {
    const request = body as unknown as VoiceEdgeModelEventRequest
    const convo = requireConversation(body)
    const sequence = typeof request.sequence === 'number' ? request.sequence : ++convo.sequence
    convo.sequence = Math.max(convo.sequence, sequence)
    const toolCalls = Array.isArray(request.tool_calls)
      ? (request.tool_calls as unknown[])
        .filter(call => typeof call === 'object' && call !== null)
        .map((call) => {
          const raw = call as Record<string, unknown>
          const rawArguments = raw['arguments']
          return {
            id: asString(raw['id']),
            name: asString(raw['name']),
            arguments: typeof rawArguments === 'string' ? rawArguments : JSON.stringify(rawArguments ?? ''),
          }
        })
      : undefined
    const text = asString(request.text)
    const reasoning = asString(request.reasoning)
    const finishReason = asString(request.finish_reason)
    convo.agent.session.append('voice-edge/model-event', {
      sequence,
      kind: asString(request.kind) || 'step',
      ...text ? { text: cap(text, EVENT_MAX_TEXT_CHARS) } : {},
      ...reasoning ? { reasoning: cap(reasoning, EVENT_MAX_TEXT_CHARS) } : {},
      ...toolCalls?.length ? { toolCalls } : {},
      ...finishReason ? { finishReason } : {},
    })
    send(res, 200, {
      conversation_key: convo.key,
      harness_session_id: convo.sessionId,
      synced: true,
      sequence: convo.sequence,
    } satisfies VoiceEdgeAck)
  }

  /** Execute one tool call as the conversation's agent; serialized per conversation. */
  async function executeTool(convo: Conversation, request: VoiceEdgeToolExecuteRequest): Promise<VoiceEdgeToolResult> {
    const callId = asString(request.call_id)
    const toolName = asString(request.name)
    if (!callId || !toolName) throw new HttpError(400, 'call_id and name are required', 'missing_call')
    convo.agent.session.append('voice-edge/tool-call', {
      callId,
      name: toolName,
      arguments: request.arguments ?? {},
    })
    const started = Date.now()
    const result = await ctx.tools.execute({
      callId: CallId(callId),
      name: toolName,
      arguments: request.arguments ?? {},
      agent: convo.agent,
      signal: AbortSignal.timeout(config.toolTimeoutMs),
    })
    const text = flattenContent(result.content)
    convo.agent.session.append('voice-edge/tool-result', {
      callId,
      name: toolName,
      isError: result.isError,
      text: cap(text, EVENT_MAX_TEXT_CHARS),
      durationMs: Date.now() - started,
    })
    return { isError: result.isError, text }
  }

  /** POST {base}/tool/execute — run one Harness tool and return only its result. */
  async function onToolExecute(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const convo = requireConversation(body)
    const request = body as unknown as VoiceEdgeToolExecuteRequest
    const run = convo.chain.then(() => executeTool(convo, request))
    // The chain must survive a failed execution: one tool's error result is
    // still a settled link, not a poisoned queue.
    convo.chain = run.catch(() => {})
    const result = await run
    convo.sequence += 1
    send(res, 200, {
      conversation_key: convo.key,
      harness_session_id: convo.sessionId,
      synced: true,
      sequence: convo.sequence,
      tool_result: result,
    } satisfies VoiceEdgeAck & { tool_result: VoiceEdgeToolResult })
  }

  /** POST {base}/turn/finish — close the turn and checkpoint durability. */
  async function onTurnFinish(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const convo = requireConversation(body)
    const request = body as unknown as VoiceEdgeTurnFinishRequest
    const sequence = typeof request.sequence === 'number' ? request.sequence : ++convo.sequence
    convo.sequence = Math.max(convo.sequence, sequence)
    convo.agent.session.append('voice-edge/finish', {
      sequence,
      status: asString(request.status) || 'completed',
    })
    await convo.chain
    // flush reports whether a durability listener participated — an assembly
    // without persistence still finished the turn, so it is its own field.
    const flushed = await ctx.sessions.flush(convo.agent.session)
    send(res, 200, {
      conversation_key: convo.key,
      harness_session_id: convo.sessionId,
      synced: true,
      sequence: convo.sequence,
      flushed,
    } satisfies VoiceEdgeAck & { flushed: boolean })
  }

  /** Single prefix handler dispatching the four endpoints plus a health seat. */
  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!authorized(req)) throw new HttpError(401, 'invalid or missing bearer token', 'unauthorized')
      const sub = new URL(req.url ?? '/', 'http://voice-edge.local').pathname.slice(base.length)
      if (sub === '' || sub === '/') {
        send(res, 200, { ok: true, plugin: name })
        return
      }
      if (req.method !== 'POST') throw new HttpError(405, 'POST only', 'method_not_allowed')
      const body = await readJson(req)
      switch (sub) {
        case '/session/sync':
          await onSync(body, res)
          return
        case '/model/event':
          onModelEvent(body, res)
          return
        case '/tool/execute':
          await onToolExecute(body, res)
          return
        case '/turn/finish':
          await onTurnFinish(body, res)
          return
        default: throw new HttpError(404, `unknown voice-edge endpoint ${JSON.stringify(sub)}`, 'not_found')
      }
    } catch (error) {
      if (error instanceof HttpError) {
        send(res, error.status, { synced: false, error: { message: error.message, type: error.type } } satisfies VoiceEdgeError)
        return
      }
      ctx.logger.warn('voice-edge', error)
      send(res, 500, {
        synced: false,
        error: { message: error instanceof Error ? error.message : String(error), type: 'internal' },
      } satisfies VoiceEdgeError)
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: base, handler }),
    'voice-edge: http route',
  )

  // Voice Edge turns are non-interactive: answer approval asks for the agents
  // this bridge owns (and ONLY those) so guarded tools can run without a UI.
  if (config.autoApprove) {
    ctx.on('approval/request', (req, next) => {
      if (bySessionId.has(req.agent.id)) return Promise.resolve<ApprovalOutcome>('allowed-once')
      return next()
    })
  }

  // Owned agents die with the plugin; adopted ones (pre-existing session id)
  // are left alone because their owner handle lives elsewhere.
  ctx.effect(() => async () => {
    for (const convo of conversations.values()) await convo.handle?.dispose()
    conversations.clear()
    aliases.clear()
    bySessionId.clear()
  }, 'voice-edge: conversation teardown')
}
