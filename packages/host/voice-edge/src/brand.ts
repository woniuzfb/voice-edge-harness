/**
 * Outbound brand rewrite for model requests leaving the Harness.
 *
 * The `voice_edge.py` gateway forwards every prompt and tool declaration it
 * receives to a third-party model. Harness-owned prompt prose still names the
 * upstream brand, so only those exact prompt brand phrases are rewritten here
 * on the outbound request — without broad `dsh` / `DSH` token replacements and
 * without any inbound tool-argument rewriting.
 * @module @deepseek-ai/dsh-voice-edge/brand
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  GenerateOptions,
  RequestMessage,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'

/** One ordered rewrite: earlier rules win, so longer phrases go first. */
export interface BrandRule {
  readonly pattern: RegExp
  readonly replacement: string
}

/** Result of rewriting one string. */
export interface BrandRewriteResult {
  readonly text: string
  readonly changed: boolean
}

/**
 * Exact prompt brand rules collected from system prompts, runtime context,
 * tool descriptions, and bundled skill prompts.
 *
 * Broad bare-token rules (`dsh` -> `veh`, `DSH` -> `VEH`) are intentionally
 * omitted so user prose, CLI commands (`dsh web`, `dsh plugin`), filesystem
 * paths (`~/.dsh/...`), workspace/repository names (`deepseek-harness`,
 * `voiceedge-harness`), environment variables (`DSH_HOME`), and manifest keys
 * (`dsh.bundle`, `engines.dsh`) remain untouched.
 */
export const BRAND_RULES: readonly BrandRule[] = [
  // Full brand names
  { pattern: /DeepSeek Harness \(DSH\)/g, replacement: 'VoiceEdge Harness (VEH)' },
  { pattern: /DeepSeek Harness/g, replacement: 'VoiceEdge Harness' },
  { pattern: /deepseek harness/g, replacement: 'voiceedge harness' },

  // packages/sandbox/sandbox-policy
  { pattern: /Current DSH file policy:/g, replacement: 'Current VEH file policy:' },
  { pattern: /the DSH file sandbox/g, replacement: 'the VEH file sandbox' },
  { pattern: /The DSH file sandbox/g, replacement: 'The VEH file sandbox' },

  // packages/context/harness-dev-context
  { pattern: /inspect or extend DSH itself/g, replacement: 'inspect or extend VEH itself' },

  // packages/boot/plugin-manager/src/tools.ts
  { pattern: /Unmet DSH version requirements/g, replacement: 'Unmet VEH version requirements' },
  { pattern: /else DSH peer dependencies/g, replacement: 'else VEH peer dependencies' },
  { pattern: /exact DSH version from list_version_exemptions/g, replacement: 'exact VEH version from list_version_exemptions' },
  { pattern: /install a DSH plugin bundle/g, replacement: 'install a VEH plugin bundle' },
  { pattern: /stop DSH and run/g, replacement: 'stop VEH and run' },
  { pattern: /compatible with the running DSH/g, replacement: 'compatible with the running VEH' },
  { pattern: /pnpm is not available to DSH/g, replacement: 'pnpm is not available to VEH' },
  { pattern: /Tell the user DSH cannot write/g, replacement: 'Tell the user VEH cannot write' },
  { pattern: /the DSH installation provides/g, replacement: 'the VEH installation provides' },
  { pattern: /modules DSH itself loaded/g, replacement: 'modules VEH itself loaded' },
  { pattern: /DSH could not compare loaded plugins/g, replacement: 'VEH could not compare loaded plugins' },
  { pattern: /restart DSH to apply this change/g, replacement: 'restart VEH to apply this change' },

  // packages/experimental/cua
  { pattern: /until this session closes or DSH restarts/g, replacement: 'until this session closes or VEH restarts' },

  // packages/experimental/plugin-recommendations
  { pattern: /after a DSH restart/g, replacement: 'after a VEH restart' },
  { pattern: /Check DSH’s optional plugins/g, replacement: 'Check VEH’s optional plugins' },
  { pattern: /Not a request to develop DSH/g, replacement: 'Not a request to develop VEH' },
  { pattern: /when the user wants DSH itself/g, replacement: 'when the user wants VEH itself' },
  { pattern: /lists DSH's built-in optional plugins/g, replacement: "lists VEH's built-in optional plugins" },
  { pattern: /Something DSH already shows/g, replacement: 'Something VEH already shows' },

  // packages/experimental/creation-recommendations
  { pattern: /removable DSH interface plugin/g, replacement: 'removable VEH interface plugin' },
  { pattern: /Use existing DSH slots and theme tokens/g, replacement: 'Use existing VEH slots and theme tokens' },
  { pattern: /documented DSH extension points/g, replacement: 'documented VEH extension points' },
  { pattern: /for any task, not just DSH/g, replacement: 'for any task, not just VEH' },
  { pattern: /DSH already has Chat, Trajectory/g, replacement: 'VEH already has Chat, Trajectory' },

  // packages/sandbox/sandbox-windows-acl
  { pattern: /unexpected DSH sandbox access denials/g, replacement: 'unexpected VEH sandbox access denials' },
  { pattern: /because DSH cannot provision its workspace grant/g, replacement: 'because VEH cannot provision its workspace grant' },
  { pattern: /DSH's `S-1-4-\*` grants/g, replacement: "VEH's `S-1-4-*` grants" },

  // packages/preset/agent-preset/skills/dsh-doc
  { pattern: /a DSH plugin/g, replacement: 'a VEH plugin' },
  { pattern: /a DSH tool definition/g, replacement: 'a VEH tool definition' },
  { pattern: /a newer DSH release/g, replacement: 'a newer VEH release' },
  { pattern: /Answer questions about DSH from the documentation/g, replacement: 'Answer questions about VEH from the documentation' },
  { pattern: /and extend DSH through bundles/g, replacement: 'and extend VEH through bundles' },
  { pattern: /asks to change DSH or its profile/g, replacement: 'asks to change VEH or its profile' },
  { pattern: /does not target DSH/g, replacement: 'does not target VEH' },
  { pattern: /installed DSH plugins/g, replacement: 'installed VEH plugins' },
  { pattern: /not the DSH installation root/g, replacement: 'not the VEH installation root' },
  { pattern: /where it appears in DSH/g, replacement: 'where it appears in VEH' },
  { pattern: /reserved for DSH's experimental packages/g, replacement: "reserved for VEH's experimental packages" },
  { pattern: /Upgrade across DSH releases/g, replacement: 'Upgrade across VEH releases' },
  { pattern: /DSH upgrade guides describe breaks in DSH surfaces/g, replacement: 'VEH upgrade guides describe breaks in VEH surfaces' },
  { pattern: /Installed DSH:/g, replacement: 'Installed VEH:' },
]

/**
 * Rewrite brand phrases inside one string.
 * @param text - Source text; returned unchanged when no rule matches.
 * @returns the rewritten text plus whether any rule fired.
 */
export function rewriteBrandText(text: string): BrandRewriteResult {
  return applyRules(text, BRAND_RULES)
}

/** Apply one ordered rule set, reporting whether the text changed. */
function applyRules(text: string, rules: readonly BrandRule[]): BrandRewriteResult {
  let out = text
  for (const rule of rules) {
    rule.pattern.lastIndex = 0
    if (rule.pattern.test(out)) {
      rule.pattern.lastIndex = 0
      out = out.replace(rule.pattern, rule.replacement)
    }
    rule.pattern.lastIndex = 0
  }
  return { text: out, changed: out !== text }
}

/** True when `value` is a plain object whose own keys may be rewritten. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as object | null
  return proto === Object.prototype || proto === null
}

/** Roles that carry prompt prose; tool results and model outputs are never rewritten. */
const PROMPT_MESSAGE_ROLES: ReadonlySet<string> = new Set(['system', 'developer', 'user'])

/** Block types inside a message that carry tool invocations or tool results rather than prompt text. */
const NON_PROMPT_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'tool-result',
  'tool_result',
  'toolResult',
  'tool-call',
  'tool_call',
  'toolCall',
])

function rewriteValue(value: unknown): unknown {
  if (typeof value === 'string') return rewriteBrandText(value).text
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((item) => {
      const next = rewriteValue(item)
      if (next !== item) changed = true
      return next
    })
    return changed ? out : value
  }
  if (!isPlainObject(value)) return value
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const next = rewriteValue(item)
    if (next !== item) changed = true
    out[key] = next
  }
  return changed ? out : value
}

/** Rewrite one content value inside a prompt message, skipping any embedded tool blocks. */
function rewritePromptContent(content: unknown): unknown {
  if (typeof content === 'string') return rewriteBrandText(content).text
  if (!Array.isArray(content)) return content
  let changed = false
  const out = content.map((block) => {
    if (isPlainObject(block) && typeof block['type'] === 'string' && NON_PROMPT_BLOCK_TYPES.has(block['type'])) {
      return block
    }
    const next = rewriteValue(block)
    if (next !== block) changed = true
    return next
  })
  return changed ? out : content
}

/**
 * Rewrite only prompt messages (`system`, `developer`, `user`), leaving tool
 * execution results (`tool`) and model replies (`assistant`) untouched.
 */
function rewritePromptMessages<T>(messages: readonly T[]): readonly T[] {
  let changed = false
  const out = messages.map((message) => {
    if (!isPlainObject(message)) return message
    const role = message['role']
    if (typeof role !== 'string' || !PROMPT_MESSAGE_ROLES.has(role)) return message
    const nextContent = rewritePromptContent(message['content'])
    if (nextContent === message['content']) return message
    changed = true
    return { ...message, content: nextContent } as T
  })
  return changed ? out : messages
}

/**
 * Rewrite one model request in place, before the adapter serializes it.
 *
 * The agent loop hands `llm.stream` a frozen request (`Object.freeze` on the
 * options, `Object.freeze` on `messages`, deep-frozen messages), so an
 * assignment here throws in strict mode. Frozen requests are left untouched
 * instead: {@link installBrandFetchRewrite} rewrites the serialized body, which
 * is the only copy the adapter can still be influenced through.
 * @param options - the request about to leave the Harness.
 * @returns whether any field changed.
 */
export function rewriteGenerateOptions(options: GenerateOptions): boolean {
  if (Object.isFrozen(options)) return false
  let changed = false
  if (typeof options.system === 'string') {
    const result = rewriteBrandText(options.system)
    if (result.changed) {
      options.system = result.text
      changed = true
    }
  }
  if (Array.isArray(options.messages) && options.messages.length > 0) {
    const messages = rewritePromptMessages(options.messages) as RequestMessage[]
    if (messages !== options.messages) {
      options.messages = messages
      changed = true
    }
  }
  if (Array.isArray(options.tools) && options.tools.length > 0 && !Object.isFrozen(options.tools)) {
    const tools = rewriteValue(options.tools) as ToolSchema[]
    if (tools !== options.tools) {
      options.tools = tools
      changed = true
    }
  }
  return changed
}

/**
 * Install the outbound brand rewrite around every provider stream.
 *
 * Registered as a global, prepended `llm/stream` listener so the rewrite runs
 * before any other middleware observes the request. A rewrite bug sends the
 * request unchanged instead of failing the turn.
 * @param ctx - Context carrying the `llm` service.
 * @returns disposer removing the listener.
 */
export function installBrandRewrite(ctx: Context): () => void {
  const dispose = ctx.on(
    'llm/stream',
    (options, next) => {
      try {
        rewriteGenerateOptions(options)
      } catch {
        // A rewrite bug must not fail the turn: send the request as-is.
      }
      return next()
    },
    { global: true, prepend: true },
  )
  return () => {
    dispose()
  }
}

/** Hosts whose cleartext JSON bodies belong to the local gateway. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** Cheap prefilter: a body that names no old-brand token cannot need rewriting. */
const OLD_BRAND_HINT = /DeepSeek Harness|deepseek harness|DSH/

/** True when `url` points at this machine over the loopback interface. */
function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * Rewrite the brand inside one already-serialized chat request body.
 *
 * This is the path that actually works: the agent loop freezes the
 * `GenerateOptions` it hands to `llm.stream`, so the adapter — not a waterfall
 * listener — owns the only mutable copy of the prompt. Rewriting the body right
 * before it leaves keeps the model-facing copy clean without touching the
 * session's own history.
 * @param url - the request target.
 * @param body - the serialized JSON body.
 * @returns the rewritten body, or `body` when nothing applied.
 */
export function rewriteChatRequestBody(url: string, body: string): string {
  if (body.length === 0 || !OLD_BRAND_HINT.test(body)) return body
  if (!isLoopbackUrl(url)) return body
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return body
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed['messages'])) {
    return body
  }
  let changed = false
  const next: Record<string, unknown> = { ...parsed }
  if (typeof parsed['system'] === 'string') {
    const sys = rewriteBrandText(parsed['system'])
    if (sys.changed) {
      next['system'] = sys.text
      changed = true
    }
  }
  const messages = rewritePromptMessages(parsed['messages'])
  if (messages !== parsed['messages']) {
    next['messages'] = messages
    changed = true
  }
  if (Array.isArray(parsed['tools'])) {
    const tools = rewriteValue(parsed['tools'])
    if (tools !== parsed['tools']) {
      next['tools'] = tools
      changed = true
    }
  }
  return changed ? JSON.stringify(next) : body
}

/**
 * Install the body rewrite in front of `fetch`.
 *
 * Adapters dispatch through `fetch`, so wrapping it catches every route —
 * including a frozen request the `llm/stream` listener cannot edit — while
 * staying limited to loopback targets so no unrelated traffic is touched.
 * @returns disposer restoring the original `fetch`.
 */
export function installBrandFetchRewrite(): () => void {
  const scope = globalThis as { fetch?: typeof fetch }
  const original = scope.fetch
  if (typeof original !== 'function') return () => {}
  const patched = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    try {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const body = init?.body
      if (typeof body === 'string') {
        const rewritten = rewriteChatRequestBody(url, body)
        if (rewritten !== body) return await original(input, { ...init, body: rewritten })
      }
    } catch {
      // A rewrite bug must not fail the turn: send the request as-is.
    }
    return original(input, init)
  }
  scope.fetch = patched
  return () => {
    if (scope.fetch === patched) scope.fetch = original
  }
}
