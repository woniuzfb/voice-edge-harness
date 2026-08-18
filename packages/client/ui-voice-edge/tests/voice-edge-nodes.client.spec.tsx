// @vitest-environment jsdom
/**
 * The voice-edge mirror Definitions over the Chat assembler: a full mirror
 * turn (sync → step with tool call → tool pair → final step) projects user,
 * assistant, and tool rows in log order; an update-only tool result stays
 * pending until its call start is prepended; text-less steps produce no
 * assistant row; renderers consume node.data only.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ChatConversationViewNode, ChatSnapshot, ConversationEventInput,
  ConversationNodeDefinition, ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type {} from '@deepseek-ai/dsh-voice-edge/types'
import { chatViewDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/chat-snapshot-builder.ts'
import {
  voiceEdgeAssistantDefinition, voiceEdgeToolDefinition, voiceEdgeUserDefinition,
} from '../src/client/definitions.ts'
import { VoiceEdgeToolView } from '../src/client/VoiceEdgeNodes.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const DEFINITIONS: readonly ConversationNodeDefinition[] = [
  voiceEdgeUserDefinition,
  voiceEdgeAssistantDefinition,
  voiceEdgeToolDefinition,
]

class TestEventDefinitions {
  entries(): readonly ConversationNodeDefinition[] {
    return DEFINITIONS
  }

  fallbackEntry(): undefined {
    return undefined
  }
}

class TestViewDefinitions {
  entries(): readonly ConversationViewDefinition[] {
    return [chatViewDefinition]
  }
}

function entry(seq: number, type: string, data: unknown): ConversationEventInput {
  return {
    event: { seq, time: 1_700_000_000_000 + seq, type, data } as ConversationEventInput['event'],
    view: undefined,
  }
}

function snapshot(entries: readonly ConversationEventInput[], hasMore = false): ChatSnapshot {
  const assembler = new ConversationNodeAssembler(new TestEventDefinitions(), new TestViewDefinitions())
  assembler.replaceWindow(entries, hasMore)
  assembler.flush()
  const value = assembler.snapshot('chat') as ChatSnapshot | undefined
  if (value === undefined) throw new Error('chat view was not registered')
  return value
}

function nodesOf(value: ChatSnapshot, kind: string): ChatConversationViewNode[] {
  return [...value.nodes.values()].filter(candidate => candidate.kind === kind)
}

/** One full mirrored turn: sync, tool-calling step, tool pair, final step, finish. */
function mirrorTurn(): ConversationEventInput[] {
  return [
    entry(1, 'voice-edge/sync', {
      requestId: 'r1',
      model: 'LLM:m365-claude-opus',
      messageCount: 2,
      messages: [
        { role: 'user', text: 'list the files' },
        { role: 'assistant', text: 'working on it' },
        { role: 'user', text: 'and now delete them' },
      ],
    }),
    entry(2, 'voice-edge/model-event', {
      sequence: 1, kind: 'step', text: '', toolCalls: [
        { id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
      ], finishReason: 'tool_calls',
    }),
    entry(3, 'voice-edge/tool-call', {
      callId: 'call-1', name: 'bash', arguments: { command: 'ls' },
    }),
    entry(4, 'voice-edge/tool-result', {
      callId: 'call-1', name: 'bash', isError: false, text: 'a.txt', durationMs: 42,
    }),
    entry(5, 'voice-edge/model-event', {
      sequence: 2, kind: 'step', text: 'done: a.txt', finishReason: 'stop',
    }),
    entry(6, 'voice-edge/finish', { sequence: 3, status: 'completed' }),
  ]
}

describe('voice-edge mirror conversation nodes', () => {
  it('projects a full mirror turn into user, assistant, and tool rows in log order', () => {
    const value = snapshot(mirrorTurn())
    expect(value.order.map(key => value.nodes.get(key)?.kind)).toEqual([
      'voice-edge-user',
      'voice-edge-tool',
      'voice-edge-assistant',
    ])
    // The user bubble carries only the LATEST user message of the projection.
    expect(nodesOf(value, 'voice-edge-user')[0]?.data).toMatchObject({
      model: 'LLM:m365-claude-opus',
      text: 'and now delete them',
    })
    // The tool-calling step had no text: no empty assistant row.
    expect(nodesOf(value, 'voice-edge-assistant')).toHaveLength(1)
    expect(nodesOf(value, 'voice-edge-assistant')[0]?.data).toMatchObject({
      text: 'done: a.txt',
      finishReason: 'stop',
    })
    expect(nodesOf(value, 'voice-edge-tool')[0]?.data).toMatchObject({
      callId: 'call-1',
      name: 'bash',
      status: 'completed',
      resultText: 'a.txt',
      durationMs: 42,
    })
  })

  it('keeps an update-only tool result pending until its start is prepended', () => {
    const result = entry(4, 'voice-edge/tool-result', {
      callId: 'call-1', name: 'bash', isError: true, text: 'boom', durationMs: 7,
    })
    const tail = snapshot([result], true)
    expect(nodesOf(tail, 'voice-edge-tool')).toHaveLength(0)
  })

  it('settles a running tool row through the live append path', () => {
    const assembler = new ConversationNodeAssembler(new TestEventDefinitions(), new TestViewDefinitions())
    assembler.replaceWindow([
      entry(1, 'voice-edge/tool-call', {
        callId: 'call-9', name: 'read_file', arguments: { path: '/tmp/a' },
      }),
    ], false)
    assembler.flush()
    const running = assembler.snapshot('chat') as ChatSnapshot
    expect(nodesOf(running, 'voice-edge-tool')[0]?.data).toMatchObject({
      status: 'running',
      argumentsText: '{"path":"/tmp/a"}',
    })

    assembler.append(entry(2, 'voice-edge/tool-result', {
      callId: 'call-9', name: 'read_file', isError: true, text: 'denied', durationMs: 3,
    }))
    assembler.flush()
    const settled = assembler.snapshot('chat') as ChatSnapshot
    const rows = nodesOf(settled, 'voice-edge-tool')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.data).toMatchObject({
      status: 'error',
      resultText: 'denied',
      durationMs: 3,
    })
  })

  it('renders a failed tool row with the error text', () => {
    const value = snapshot([
      entry(1, 'voice-edge/tool-call', {
        callId: 'call-1', name: 'bash', arguments: { command: 'rm -rf /' },
      }),
      entry(2, 'voice-edge/tool-result', {
        callId: 'call-1', name: 'bash', isError: true, text: 'permission denied', durationMs: 5,
      }),
    ])
    const row = nodesOf(value, 'voice-edge-tool')[0]
    expect(row).toBeDefined()
    const t = makeTranslate(zh, commonZh)
    const props = {
      node: { key: 'voice-edge-tool:call-1', data: row?.data },
      t,
    } as unknown as Parameters<typeof VoiceEdgeToolView>[0]
    const { container } = render(<VoiceEdgeToolView {...props} />)
    expect(container.textContent).toContain('bash')
    expect(container.textContent).toContain(zh['tool.failed'])
    expect(container.textContent).toContain('permission denied')
  })
})
