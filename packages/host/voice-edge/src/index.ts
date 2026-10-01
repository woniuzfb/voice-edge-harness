/**
 * Voice Edge bridge plugin. Exposes a token-authenticated HTTP API under
 * `config.path` (default `/api/voice-edge`) on the composed `webServer`
 * service so an external voice_edge.py process can:
 *
 *   1. bind one of its conversations to a Harness session (`session/bind`),
 *      receiving the Harness tool schemas visible to that session's agent;
 *   2. append one mirror event — user turn, model step, finish — into the
 *      session log (`event`);
 *   3. execute Harness tools as that agent (`tool/execute`).
 *
 * Boundary contract: the plugin never returns model context (no messages, no
 * system prompt, no assembled history) — voice_edge.py remains the sole owner
 * of the model request and of the client-visible output, and every mirror
 * append is content the client explicitly delivered. The plugin's own log
 * writes are only the tool-call/tool-result pairs of executions it performed.
 * The Harness agent created per conversation is a scope and session container
 * only; the plugin never submits inbox work, so its loop never runs a model.
 * @module @deepseek-ai/dsh-voice-edge
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { normalizeSessionTitle } from '@deepseek-ai/dsh-session-title'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
// Type-only edges: resolve the `webServer` and `agentPresets` Context service
// merges and the `approval/request` Events merge this plugin consumes.
import type {} from '@deepseek-ai/dsh-agent-preset'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {
  VoiceEdgeAck,
  VoiceEdgeBindRequest,
  VoiceEdgeError,
  VoiceEdgeEventRequest,
  VoiceEdgeMessageProjection,
  VoiceEdgeToolExecuteRequest,
  VoiceEdgeToolResult,
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
  /**
   * Active Continue generate-title turn: the instruction arrived but the turn
   * has not finished. Mirror events are withheld (the turn is not conversation
   * content) and the last step text becomes the title at finish.
   */
  titleTurn?: { text: string } | undefined
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

/** Mirror texts are stored verbatim: `config.maxBodyBytes` is the single size
 * bound, enforced at the HTTP wire — the log never truncates what arrived. */

/** Placeholder title every voice-edge session carries until a generated or user title lands. */
const DEFAULT_TITLE = 'voice-edge'
/** UTF-8 byte budget for generated titles; Continue asks the model for 3-4 words. */
const TITLE_MAX_BYTES = 200

/**
 * Continue's generateTitle request rides the same conversation as an ordinary
 * fresh user turn: the fixed instruction opens the text and the conversation
 * content follows. The model's reply is the title itself, so the turn never
 * mirrors into the log — it folds into `session/title` at finish.
 */
function isTitleGenerationPrompt(text: string): boolean {
  return text.startsWith('Given the following') && text.includes('please reply with a title')
}

/**
 * A generated title only replaces the placeholder: once a real title stands —
 * an earlier generation, or an explicit user rename, which pins — the session
 * keeps it.
 */
function generatedTitleApplies(session: Session): boolean {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  const latest = session.snapshotEvents().findLast(event => event.type === 'session/title')
  return latest === undefined || latest.data.title === DEFAULT_TITLE
}

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

/** Stable session identity for a conversation key; the raw key never leaves the process. */
function sessionIdFor(conversationKey: string): SessionId {
  const digest = createHash('sha256').update(conversationKey).digest('hex')
  return SessionId(`voice-edge-${digest}`)
}

/**
 * Project client-delivered messages verbatim. The wire contract is the event
 * projection itself — `{ role, name?, text }` per message, `text` a plain
 * string (voice_edge.py taps its relay-extracted turn text there) — so this
 * only drops messages that are not objects. No re-parse of client content
 * shapes exists on this path by design.
 */
function projectMessages(messages: unknown): VoiceEdgeMessageProjection[] {
  if (!Array.isArray(messages)) return []
  const projected: VoiceEdgeMessageProjection[] = []
  for (const raw of messages) {
    if (typeof raw !== 'object' || raw === null) continue
    const message = raw as Record<string, unknown>
    projected.push({
      role: asString(message['role']) || 'unknown',
      ...asString(message['name']) ? { name: asString(message['name']) } : {},
      text: asString(message['text']),
    })
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

  // A durable delete (workspace.deleteSession) structurally disposes the agent
  // through the registry; drop the bound conversation here so the next Python
  // request rebinds or recreates instead of holding a stale agent reference.
  ctx.on('session/disposed', (session: Session) => {
    const convo = bySessionId.get(session.id)
    if (convo === undefined) return
    conversations.delete(convo.key)
    bySessionId.delete(session.id)
    for (const [alias, target] of aliases) {
      if (target === convo.key) aliases.delete(alias)
    }
  })

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
   * in-memory alias tables, so a later bind's lookup misses; probing the
   * durable store for the claimed key's session (a continuation) or the boot
   * key's (the turn-1 mirror) and resuming it keeps one conversation on one
   * session. A live agent on any candidate id (e.g. the Web client resumed
   * the mirrored conversation through apiproxy) is re-attached as the
   * binding — resuming under it would hit the persistence coordinator's
   * live-session refusal. Creating a same-id fresh session instead would
   * desynchronize the in-memory log from the durable one, and the persistence
   * backend rejects the mismatched materialization at the next flush — losing
   * the whole turn.
   */
  async function createConversation(key: string, bootKey: string, cwd: string | undefined): Promise<Conversation> {
    const sessionId = sessionIdFor(key)
    // Same first-user-line boot collision semantics as the in-memory alias:
    // the boot candidate may adopt another conversation's session exactly
    // where the pre-restart alias lookup would have merged them too.
    const candidates = [sessionId, ...bootKey !== '' && bootKey !== key ? [sessionIdFor(bootKey)] : []]
    for (const candidate of candidates) {
      const existing = ctx.agents.get(candidate)
      if (existing !== undefined) {
        return { key, sessionId: candidate, agent: existing, sequence: 0, chain: Promise.resolve(), touched: Date.now() }
      }
    }
    let resumeSessionId: SessionId | undefined
    const persistence = ctx.get('sessionPersistence')
    if (persistence !== undefined) {
      const snapshots = await persistence.list()
      resumeSessionId = candidates.find(id => snapshots.some(snapshot => snapshot.header.id === id))
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
    // Every voice-edge session carries the placeholder title from creation —
    // and adopted pre-title sessions gain it on resume — because the client's
    // untitled display falls back to the cwd basename, which names the
    // Harness checkout rather than this conversation surface.
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    if (!handle.agent.session.snapshotEvents().some(event => event.type === 'session/title')) {
      handle.agent.session.append('session/title', {
        title: DEFAULT_TITLE,
        messageSeqs: [],
        source: { kind: 'user' },
      })
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

  /** POST {base}/session/bind — bind a conversation and return tool schemas. Records nothing. */
  async function onBind(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const request = body as unknown as VoiceEdgeBindRequest
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
      throw new HttpError(409, `unknown conversation_key ${JSON.stringify(key)} — call session/bind first`, 'unknown_conversation')
    }
    convo.touched = Date.now()
    return convo
  }

  /** POST {base}/event — append one client-delivered mirror event. */
  async function onEvent(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const request = body as unknown as VoiceEdgeEventRequest
    const convo = requireConversation(body)
    switch (asString(request.type)) {
      case 'voice-edge/sync': {
        convo.sequence += 1
        const messages = Array.isArray(request.messages) ? request.messages : []
        const projected = projectMessages(messages)
        const userText = projected.find(message => message.role === 'user')?.text ?? ''
        if (generatedTitleApplies(convo.agent.session) && isTitleGenerationPrompt(userText)) {
          // A generate-title turn mirrors nothing: the instruction and the
          // model's title reply are not conversation content. Sessions with a
          // standing title skip detection entirely — the turn mirrors as
          // ordinary content.
          convo.titleTurn = { text: '' }
          break
        }
        // An ordinary turn supersedes any title turn that never finished.
        convo.titleTurn = undefined
        const bootKey = asString(request.boot_key)
        const fullKey = asString(request.full_key)
        convo.agent.session.append('voice-edge/sync', {
          requestId: asString(request.request_id),
          model: asString(request.model),
          messageCount: messages.length,
          messages: projected,
          ...bootKey ? { bootKey } : {},
          ...fullKey ? { fullKey } : {},
        })
        break
      }
      case 'voice-edge/model-event': {
        const sequence = typeof request.sequence === 'number' ? request.sequence : ++convo.sequence
        convo.sequence = Math.max(convo.sequence, sequence)
        const text = asString(request.text)
        if (convo.titleTurn !== undefined) {
          // The title reply itself: withheld with the turn; the last non-empty
          // step text is what finish folds into session/title.
          if (text !== '') convo.titleTurn = { text }
          break
        }
        const reasoning = asString(request.reasoning)
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
        const finishReason = asString(request.finish_reason)
        convo.agent.session.append('voice-edge/model-event', {
          sequence,
          kind: asString(request.kind) || 'step',
          ...text ? { text } : {},
          ...reasoning ? { reasoning } : {},
          ...toolCalls?.length ? { toolCalls } : {},
          ...finishReason ? { finishReason } : {},
        })
        break
      }
      case 'voice-edge/finish': {
        const sequence = typeof request.sequence === 'number' ? request.sequence : ++convo.sequence
        convo.sequence = Math.max(convo.sequence, sequence)
        const titleTurn = convo.titleTurn
        convo.titleTurn = undefined
        if (titleTurn !== undefined) {
          const title = normalizeSessionTitle(titleTurn.text, TITLE_MAX_BYTES)
          if (title !== '' && generatedTitleApplies(convo.agent.session)) {
            convo.agent.session.append('session/title', {
              title,
              messageSeqs: [],
              source: { kind: 'user' },
            })
          }
        }
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
        return
      }
      default:
        throw new HttpError(400, `unsupported event type ${JSON.stringify(asString(request.type))}`, 'unsupported_event')
    }
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
      callId: ToolCallId(callId),
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
      text,
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

  /** Single prefix handler dispatching the three endpoints plus a health seat. */
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
        case '/session/bind':
          await onBind(body, res)
          return
        case '/event':
          await onEvent(body, res)
          return
        case '/tool/execute':
          await onToolExecute(body, res)
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
