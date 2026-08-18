/**
 * Keyed Chat renderers for the voice-edge mirror rows. Each consumes only
 * `node.data` and the locale face — no Session window or snapshot scanning.
 */

import { memo } from 'react'
import { MessageText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  VoiceEdgeAssistantNode, VoiceEdgeToolNode, VoiceEdgeUserNode,
} from './definitions.ts'
import css from './VoiceEdgeNodes.module.css'

/** Right-aligned mirrored user bubble, mirroring the client chat's own user rows. */
export const VoiceEdgeUserView = memo(function VoiceEdgeUserView({
  node, t,
}: PropsRuntime<'conversation.chat.node', 'voice-edge-user'> & PropsLocale<'voiceEdge'>) {
  const data: VoiceEdgeUserNode = node.data
  return (
    <div className={css.userRow} role="group" aria-label={t('user.aria')}>
      <div className={css.userStack}>
        <div className={css.userBubble}>
          <MessageText text={data.text} />
        </div>
      </div>
    </div>
  )
})

/** Left-aligned mirrored assistant step: optional reasoning block, then the step text. */
export const VoiceEdgeAssistantView = memo(function VoiceEdgeAssistantView({
  node, t,
}: PropsRuntime<'conversation.chat.node', 'voice-edge-assistant'> & PropsLocale<'voiceEdge'>) {
  const data: VoiceEdgeAssistantNode = node.data
  return (
    <div className={css.assistantRow} role="group" aria-label={t('assistant.aria')}>
      {data.reasoning !== '' && (
        <div className={css.reasoning}>
          <span className={css.reasoningLabel}>{t('reasoning.label')}</span>
          {data.reasoning}
        </div>
      )}
      {data.text !== '' && (
        <div className={css.assistantText}>
          <MessageText text={data.text} />
        </div>
      )}
    </div>
  )
})

/** One-line status of one Harness tool execution; failures expand the result text. */
export const VoiceEdgeToolView = memo(function VoiceEdgeToolView({
  node, t,
}: PropsRuntime<'conversation.chat.node', 'voice-edge-tool'> & PropsLocale<'voiceEdge'>) {
  const data: VoiceEdgeToolNode = node.data
  const status = data.status === 'running'
    ? t('tool.running')
    : data.status === 'error'
      ? t('tool.failed')
      : `${t('tool.succeeded')}${data.durationMs === undefined ? '' : ` · ${data.durationMs} ms`}`
  return (
    <div className={css.toolRow} role="group" aria-label={t('tool.aria')}>
      <div className={css.toolHead}>
        <span className={css.toolName}>{data.name}</span>
        <span className={data.status === 'error' ? `${css.toolStatus} ${css.toolStatusError}` : css.toolStatus}>
          {status}
        </span>
      </div>
      {data.status === 'error' && data.resultText !== undefined && data.resultText !== '' && (
        <div className={css.toolBody}>{data.resultText}</div>
      )}
    </div>
  )
})
