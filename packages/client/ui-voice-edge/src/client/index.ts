/**
 * Voice Edge conversation-mirror plugin, browser half: three Chat node
 * Definitions over the `voice-edge/*` session events plus their keyed
 * renderers. The Host bridge owns the event log; this package owns only how
 * the mirror reads in the Chat view.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
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
export const inject = ['uiConversation', 'slots', 'locale']

/**
 * Client plugin body: the three mirror Definitions and their Chat renderers.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.uiConversation.events.register(voiceEdgeUserDefinition)
  ctx.uiConversation.events.register(voiceEdgeAssistantDefinition)
  ctx.uiConversation.events.register(voiceEdgeToolDefinition)
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
