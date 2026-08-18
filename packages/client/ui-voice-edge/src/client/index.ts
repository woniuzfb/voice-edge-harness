/**
 * Voice Edge conversation-mirror plugin, browser half: three Chat node
 * Definitions over the `voice-edge/*` session events plus their keyed
 * renderers. The Host bridge owns the event log; this package owns only how
 * the mirror reads in the Chat view.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-conversation ChatNodeDataMap / slot merges.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only edge: the `voice-edge/*` SessionEventMap merge (producer-owned).
import type {} from '@deepseek-ai/dsh-voice-edge/types'
import {
  voiceEdgeAssistantDefinition, voiceEdgeToolDefinition, voiceEdgeUserDefinition,
} from './definitions.ts'
import {
  VoiceEdgeAssistantView, VoiceEdgeToolView, VoiceEdgeUserView,
} from './VoiceEdgeNodes.tsx'
import { en, zh, type VoiceEdgeKey } from './locales.ts'

export {
  voiceEdgeAssistantDefinition, voiceEdgeToolDefinition, voiceEdgeUserDefinition,
} from './definitions.ts'
export type {
  VoiceEdgeAssistantNode, VoiceEdgeToolNode, VoiceEdgeUserNode,
} from './definitions.ts'
export {
  VoiceEdgeAssistantView, VoiceEdgeToolView, VoiceEdgeUserView,
} from './VoiceEdgeNodes.tsx'
export type { VoiceEdgeKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The voice-edge mirror rows' copy. */
    voiceEdge: VoiceEdgeKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'voiceEdge'

/** Required services for the mirror Definitions, keyed renderers, and copy. */
export const inject = ['conversationEvents', 'slots', 'locale']

/**
 * Client plugin body: the three mirror Definitions and their Chat renderers.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.conversationEvents.register(voiceEdgeUserDefinition)
  ctx.conversationEvents.register(voiceEdgeAssistantDefinition)
  ctx.conversationEvents.register(voiceEdgeToolDefinition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-voice-edge: dictionaries')

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'voice-edge-user',
    locale: NS,
  }, VoiceEdgeUserView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'voice-edge-assistant',
    locale: NS,
  }, VoiceEdgeAssistantView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'voice-edge-tool',
    locale: NS,
  }, VoiceEdgeToolView))
}
