/**
 * Chat-view projections of the voice-edge mirror events. The Host bridge
 * (`@deepseek-ai/dsh-voice-edge`) records voice_edge.py turns as log-only
 * `voice-edge/*` session events; without these Definitions the Chat view
 * matches nothing and the conversation renders blank.
 *
 * Identity discipline (cookbook): every kind derives its id from durable
 * payload — `event.seq` for single-event rows (sync, model-event), `callId`
 * for the tool call/result pair. `voice-edge/finish` carries no renderable
 * content and is deliberately unmatched.
 */

import type {
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only edge: the `voice-edge/*` SessionEventMap merge lives with the
// event producer; the client never re-declares payload shapes.
import type {} from '@deepseek-ai/dsh-voice-edge/types'

/** One mirrored user turn row (from `voice-edge/sync`). */
export interface VoiceEdgeUserNode {
  readonly seq: number
  readonly time: number
  /** The synced turn's model id (e.g. `LLM:m365-claude-opus`). */
  readonly model: string
  /** Latest user message of the synced history projection. */
  readonly text: string
}

/** One mirrored model step row (from `voice-edge/model-event`). */
export interface VoiceEdgeAssistantNode {
  readonly seq: number
  readonly time: number
  readonly text: string
  readonly reasoning: string
  readonly finishReason: string
}

/** One Harness tool call row (from the `voice-edge/tool-call`/`tool-result` pair). */
export interface VoiceEdgeToolNode {
  readonly callId: string
  readonly name: string
  readonly argumentsText: string
  readonly seq: number
  readonly time: number
  readonly status: 'running' | 'completed' | 'error'
  readonly resultText?: string
  readonly durationMs?: number
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** Mirrored voice-edge user turn. */
    'voice-edge-user': VoiceEdgeUserNode
    /** Mirrored voice-edge model step. */
    'voice-edge-assistant': VoiceEdgeAssistantNode
    /** Mirrored Harness tool execution. */
    'voice-edge-tool': VoiceEdgeToolNode
  }
}

/** The synced projection's latest user message text, or '' when absent. */
function latestUserText(messages: readonly { role: string; text: string }[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message !== undefined && message.role === 'user') return message.text
  }
  return ''
}

/** `voice-edge/sync` → one user bubble per synced turn. */
export const voiceEdgeUserDefinition: ConversationNodeDefinition<VoiceEdgeUserNode> = {
  kind: 'voice-edge-user',
  target: 'chat',
  match: event => event.type === 'voice-edge/sync'
    ? { id: `sync-${event.seq}`, role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'voice-edge/sync') {
      throw new Error('voice-edge-user start requires voice-edge/sync')
    }
    return {
      seq: match.event.seq,
      time: match.event.time,
      model: match.event.data.model,
      text: latestUserText(match.event.data.messages),
    }
  },
  update: context => context.state,
  buildViewNode: (context) => {
    // A sync without a user message (tool-only continuation) has no bubble to
    // show; never having published, null is the correct absence.
    if (context.state === undefined || context.state.text === '') return null
    return {
      key: context.key,
      kind: 'voice-edge-user',
      id: context.id,
      target: 'chat',
      anchorSeq: context.state.seq,
      location: context.start?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      data: context.state,
    }
  },
}

/** `voice-edge/model-event` → one assistant row per mirrored model step. */
export const voiceEdgeAssistantDefinition: ConversationNodeDefinition<VoiceEdgeAssistantNode> = {
  kind: 'voice-edge-assistant',
  target: 'chat',
  match: event => event.type === 'voice-edge/model-event'
    ? { id: `model-event-${event.seq}`, role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'voice-edge/model-event') {
      throw new Error('voice-edge-assistant start requires voice-edge/model-event')
    }
    return {
      seq: match.event.seq,
      time: match.event.time,
      text: match.event.data.text ?? '',
      reasoning: match.event.data.reasoning ?? '',
      finishReason: match.event.data.finishReason ?? '',
    }
  },
  update: context => context.state,
  buildViewNode: (context) => {
    // Tool-call-only steps render as tool rows; an empty row adds nothing.
    if (context.state === undefined) return null
    if (context.state.text === '' && context.state.reasoning === '') return null
    return {
      key: context.key,
      kind: 'voice-edge-assistant',
      id: context.id,
      target: 'chat',
      anchorSeq: context.state.seq,
      location: context.start?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      data: context.state,
    }
  },
}

/** The tool-row State: the call opens it, the paired result settles it. */
export const voiceEdgeToolDefinition: ConversationNodeDefinition<VoiceEdgeToolNode> = {
  kind: 'voice-edge-tool',
  target: 'chat',
  match: (event) => {
    if (event.type === 'voice-edge/tool-call') {
      return { id: `tool-${event.data.callId}`, role: 'start' }
    }
    if (event.type === 'voice-edge/tool-result') {
      return { id: `tool-${event.data.callId}`, role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'voice-edge/tool-call') {
      throw new Error('voice-edge-tool start requires voice-edge/tool-call')
    }
    return {
      callId: match.event.data.callId,
      name: match.event.data.name,
      argumentsText: JSON.stringify(match.event.data.arguments),
      seq: match.event.seq,
      time: match.event.time,
      status: 'running',
    }
  },
  update: (context, match) => {
    if (match.event.type !== 'voice-edge/tool-result') {
      return context.state
    }
    return {
      ...context.state,
      status: match.event.data.isError ? 'error' : 'completed',
      resultText: match.event.data.text,
      durationMs: match.event.data.durationMs,
    }
  },
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return {
      key: context.key,
      kind: 'voice-edge-tool',
      id: context.id,
      target: 'chat',
      anchorSeq: context.state.seq,
      location: context.start?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      data: context.state,
    }
  },
}
