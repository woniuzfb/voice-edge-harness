/**
 * Keyed Chat renderers for the voice-edge mirror rows. Each consumes only
 * `node.data` and the locale face — no Session window or snapshot scanning.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  dataImageSrc, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular,
  IconCopyOutlineRegular, MarkdownText, Tooltip, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {
  VoiceEdgeAssistantNode, VoiceEdgeToolNode, VoiceEdgeUserNode,
} from './definitions.ts'
import css from './VoiceEdgeNodes.module.css'

function MessageText({ text }: { text: string }) {
  return <div className={css.text}>{text}</div>
}

/**
 * Copy action for a mirrored bubble. The success chrome reuses the
 * conversation-message pattern: a one-second check swap after the clipboard
 * write, gated so re-clicks during the window neither re-copy nor stack
 * timers.
 */
function CopyAction({ text, t }: { text: string; t: PropsLocale<'voiceEdge'>['t'] }) {
  const [copied, setCopied] = useState(false)
  const pending = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const epoch = useRef(0)
  useEffect(() => () => {
    epoch.current += 1
    pending.current = false
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])
  const onCopy = useCallback(() => {
    if (copied || pending.current) return
    const at = epoch.current
    pending.current = true
    void writeClipboard(text).then((ok) => {
      if (at !== epoch.current) return
      pending.current = false
      if (!ok) return
      setCopied(true)
      timer.current = window.setTimeout(() => {
        timer.current = null
        setCopied(false)
      }, 1000)
    })
  }, [copied, text])
  return (
    <Tooltip label={copied ? t('copied') : t('copy')} side="bottom">
      <button
        type="button"
        className={css.actionButton}
        aria-label={copied ? t('copied') : t('copy')}
        onClick={onCopy}
      >
        {copied ? <IconCheckOutlineRegular /> : <IconCopyOutlineRegular />}
      </button>
    </Tooltip>
  )
}

/**
 * Smooth-scroll to the previous/next mirrored user message, hopping between
 * the rows this module stamps with `data-voice-edge-user`. Navigation targets
 * live outside React state, so the walk happens in the DOM on click; at the
 * ends of the flow the hop is a no-op.
 */
function scrollToUserMessage(from: HTMLElement, direction: -1 | 1): void {
  const current = from.closest<HTMLElement>('[data-voice-edge-user]')
  if (current === null) return
  const rows = [...document.querySelectorAll<HTMLElement>('[data-voice-edge-user]')]
  const index = rows.indexOf(current)
  if (index < 0) return
  rows[index + direction]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/** Chevron hop to the previous/next user message, riding a bubble action row. */
function UserNavAction({ direction, t }: {
  direction: -1 | 1
  t: PropsLocale<'voiceEdge'>['t']
}) {
  const label = direction < 0 ? t('nav.prevUser') : t('nav.nextUser')
  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        className={css.actionButton}
        aria-label={label}
        onClick={(event) => { scrollToUserMessage(event.currentTarget, direction) }}
      >
        {direction < 0 ? <IconChevronUpOutlineRegular /> : <IconChevronDownOutlineRegular />}
      </button>
    </Tooltip>
  )
}

/**
 * Literal-text projection of a mirrored user turn. User input is not trusted
 * Markdown: everything renders as typed, except the mirror's own re-embedded
 * inline images (`![name](data:image/…;base64,…)` — they rode the host's
 * attachment channel to the model, not the text). Those alone are parsed, and
 * only through the same raster gate the assistant path uses: a malformed or
 * truncated data URI falls back to its alt text without leaking the payload,
 * and non-data-URI image syntax stays literal text the user typed.
 */
function projectUserMirrorText(text: string): ReactNode {
  // Alt holds no `]`; the mirror's data URIs carry no whitespace or `)`.
  const re = /!\[([^\]]*)\]\((data:image\/[^)\s]*)\)/g
  const parts: ReactNode[] = []
  let cursor = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const alt = m[1] ?? ''
    const src = dataImageSrc(m[2] ?? '')
    if (src === undefined) {
      // A data URI the raster gate rejects (truncated payload, SVG, foreign
      // mime): the mirror's own syntax gone bad, so it collapses to the alt
      // text instead of dumping its payload as a literal text wall.
      if (m.index > cursor) parts.push(<MessageText key={cursor} text={text.slice(cursor, m.index)} />)
      if (alt !== '') parts.push(<span key={`alt-${m.index}`} className={css.userImageAlt}>{alt}</span>)
    } else {
      if (m.index > cursor) parts.push(<MessageText key={cursor} text={text.slice(cursor, m.index)} />)
      parts.push(
        <img key={m.index} className={css.userImage} src={src} alt={alt} loading="lazy" decoding="async" />,
      )
    }
    cursor = m.index + m[0].length
  }
  if (parts.length === 0) return <MessageText text={text} />
  if (cursor < text.length) parts.push(<MessageText key={cursor} text={text.slice(cursor)} />)
  return <>{parts}</>
}

/**
 * Right-aligned mirrored user bubble. The mirrored turn text is the user's
 * literal input — rendered as typed through {@link projectUserMirrorText},
 * which additionally displays the mirror's re-embedded inline images.
 */
export const VoiceEdgeUserView = memo(function VoiceEdgeUserView({
  node, t,
}: PropsRuntime<'conversation.chat.node', 'voice-edge-user'> & PropsLocale<'voiceEdge'>) {
  const data: VoiceEdgeUserNode = node.data
  return (
    <div
      className={css.userRow}
      data-voice-edge-user=""
      role="group"
      aria-label={t('user.aria')}
    >
      <div className={css.userStack}>
        <div className={css.userBubble}>
          {projectUserMirrorText(data.text)}
        </div>
        {data.text !== '' && (
          <div className={css.bubbleActions}>
            <CopyAction text={data.text} t={t} />
            <UserNavAction direction={-1} t={t} />
            <UserNavAction direction={1} t={t} />
          </div>
        )}
      </div>
    </div>
  )
})

/**
 * Left-aligned mirrored assistant step: optional reasoning block (literal),
 * then the step text as assistant Markdown — a mirror of another surface's
 * model output, so it renders like any assistant reply, inline `data:image`
 * images included.
 */
export const VoiceEdgeAssistantView = memo(function VoiceEdgeAssistantView({
  node, t,
}: PropsRuntime<'conversation.chat.node', 'voice-edge-assistant'> & PropsLocale<'voiceEdge'>) {
  const data: VoiceEdgeAssistantNode = node.data
  const markdownLabels = useMemo<MarkdownLabels>(() => ({
    code: {
      copyLabel: t('copy'),
      copiedLabel: t('copied'),
      toolbarLabels: {
        codeLabel: t('codeBlock.title'),
        wrapLabel: t('codeBlock.wrap'),
        unwrapLabel: t('codeBlock.unwrap'),
      },
    },
    footnotes: t('markdown.footnotes'),
  }), [t])
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
          <MarkdownText text={data.text} labels={markdownLabels} />
        </div>
      )}
      {data.text !== '' && (
        <div className={css.bubbleActionsAssistant}>
          <CopyAction text={data.text} t={t} />
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
