/**
 * Voice Edge wire vocabulary and log-only session events. The plugin mirrors
 * voice_edge.py turns into Harness sessions: it NEVER stores model context it
 * was not explicitly given, and it never returns model context — the session
 * log is a durable mirror plus a tool-execution record, nothing more.
 * @module @deepseek-ai/dsh-voice-edge/types
 */

import type { JsonValue } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One voice_edge.py turn was bound to this Harness session. `messages` is
     * a bounded role/text projection of the client history at sync time — a
     * diagnostic mirror, never a model-context source. `bootKey`/`fullKey`
     * are the voice-edge identity hashes aliased to this session.
     */
    'voice-edge/sync': {
      requestId: string
      model: string
      messageCount: number
      messages: VoiceEdgeMessageProjection[]
      bootKey?: string
      fullKey?: string
    }
    /**
     * One model step observed by voice_edge.py (assistant text, reasoning,
     * parsed tool calls, finish reason). Log-only mirror of the external
     * model stream; the Harness agent owning this session never drives a
     * model itself.
     */
    'voice-edge/model-event': {
      sequence: number
      kind: string
      text?: string
      reasoning?: string
      toolCalls?: VoiceEdgeToolCallMirror[]
      finishReason?: string
    }
    /** A Harness tool call dispatched by voice_edge.py, before execution. */
    'voice-edge/tool-call': {
      callId: string
      name: string
      arguments: JsonValue
    }
    /** The settled outcome paired to `voice-edge/tool-call` by `callId`. */
    'voice-edge/tool-result': {
      callId: string
      name: string
      isError: boolean
      /** Flattened model-facing text of the result content blocks. */
      text: string
      durationMs: number
    }
    /** voice_edge.py finished the turn; paired with a durability flush. */
    'voice-edge/finish': {
      sequence: number
      status: string
    }
  }
}

/** Bounded per-message mirror stored by `voice-edge/sync`. */
export interface VoiceEdgeMessageProjection {
  role: string
  /** Tool name for tool-role messages; absent otherwise. */
  name?: string
  /** Flattened text, truncated by the plugin before append. */
  text: string
}

/** One parsed tool call mirrored from the external model stream. */
export interface VoiceEdgeToolCallMirror {
  id: string
  name: string
  arguments: string
}

/** POST {path}/session/sync request body. */
export interface VoiceEdgeSyncRequest {
  conversation_key?: string
  boot_key?: string
  full_key?: string
  request_id?: string
  model?: string
  /** Working directory for a newly created Harness agent. */
  cwd?: string
  /** Client message history; mirrored bounded, never returned. */
  messages?: unknown[]
}

/** POST {path}/model/event request body. */
export interface VoiceEdgeModelEventRequest {
  conversation_key: string
  sequence?: number
  kind?: string
  text?: string
  reasoning?: string
  tool_calls?: VoiceEdgeToolCallMirror[]
  finish_reason?: string
}

/** POST {path}/tool/execute request body. */
export interface VoiceEdgeToolExecuteRequest {
  conversation_key: string
  call_id: string
  name: string
  arguments?: JsonValue
}

/** POST {path}/turn/finish request body. */
export interface VoiceEdgeTurnFinishRequest {
  conversation_key: string
  sequence?: number
  status?: string
}

/** The tool result projection returned to voice_edge.py. */
export interface VoiceEdgeToolResult {
  isError: boolean
  /** Flattened text of the result content blocks. */
  text: string
}

/** Shared success-envelope fields. `harness_session_id` is diagnostic. */
export interface VoiceEdgeAck {
  conversation_key: string
  harness_session_id: string
  synced: boolean
  sequence: number
}

/** Failure envelope for every endpoint. */
export interface VoiceEdgeError {
  conversation_key?: string
  synced: false
  error: { message: string; type: string }
}
