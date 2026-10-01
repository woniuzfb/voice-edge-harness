/** Package-owned durable voice-edge event invariants. @module @deepseek-ai/dsh-voice-edge/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-voice-edge'

/** Cordis companion plugin name. */
export const name = 'voice-edge-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Require a trimmed string field on one voice-edge event payload. */
function requireString(data: Record<string, unknown>, field: string, event: string, fail: InvariantFailure): void {
  if (typeof data[field] !== 'string') fail(`${event} ${field} must be a string`)
}

/** Require a non-negative integer field on one voice-edge event payload. */
function requireSeq(data: Record<string, unknown>, field: string, event: string, fail: InvariantFailure): void {
  const value = data[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(`${event} ${field} must be a non-negative integer`)
  }
}

/** Validate the package-owned event fields and ignore unrelated events. */
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  const data = event.data as Record<string, unknown>
  switch (event.type) {
    case 'voice-edge/sync':
      requireSeq(data, 'messageCount', event.type, fail)
      if (!Array.isArray(data['messages'])) fail('voice-edge/sync messages must be an array')
      break
    case 'voice-edge/model-event':
      requireSeq(data, 'sequence', event.type, fail)
      requireString(data, 'kind', event.type, fail)
      break
    case 'voice-edge/tool-call':
      requireString(data, 'callId', event.type, fail)
      requireString(data, 'name', event.type, fail)
      break
    case 'voice-edge/tool-result':
      requireString(data, 'callId', event.type, fail)
      if (typeof data['isError'] !== 'boolean') fail('voice-edge/tool-result isError must be a boolean')
      break
    case 'voice-edge/finish':
      requireSeq(data, 'sequence', event.type, fail)
      requireString(data, 'status', event.type, fail)
      break
    default:
      break
  }
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Install validation for loaded and newly appended voice-edge events. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    for (const event of session.snapshotEvents()) validateEvent(event, fail)
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const event = (args as [Session, SessionEvent])[1]
    validateEvent(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the voice-edge invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
