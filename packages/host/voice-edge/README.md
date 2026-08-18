# @deepseek-ai/dsh-voice-edge

English | [中文](README.zh.md)

Voice Edge bridge: lets an external `voice_edge.py` process bind its conversations to Harness sessions, mirror model events into the durable session log, and execute Harness tools — all over a token-authenticated HTTP prefix on the composed `webServer` service.

## Boundary contract

- The plugin **never returns model context** (no messages, system prompts, or assembled history). `voice_edge.py` owns the model request and the client-visible output; the Harness session is a durable mirror plus a tool-execution host.
- The Harness agent created per conversation is a scope/session container only. The plugin never submits inbox work, so the agent loop never runs a model for it.
- Session identity is `voice-edge-<sha256(conversation_key)>`; the raw key never enters paths or external resource names.

## Endpoints

All endpoints live under `config.path` (default `/api/voice-edge`), require `Authorization: Bearer <config.token>`, and accept/return JSON.

| POST | Purpose | Returns (beyond the ack fields) |
| --- | --- | --- |
| `/session/sync` | Bind `conversation_key` (boot/full key aliases resolve to the same session) and mirror a bounded history projection | `tools`: Harness tool schemas visible to that agent |
| `/model/event` | Mirror one external model step (text, reasoning, tool calls, finish reason) | — |
| `/tool/execute` | Execute one Harness tool as the conversation's agent (serialized per conversation) | `tool_result`: `{ isError, text }` |
| `/turn/finish` | Append the finish marker and dispatch the `session/flush` durability checkpoint | `flushed`: whether a persistence listener participated |

Ack fields on success: `conversation_key`, `harness_session_id` (diagnostic), `synced`, `sequence`. Failures return `{ synced: false, error: { message, type } }` with an HTTP status.

## Session events

Log-only mirror events (merged into `SessionEventMap`, registered in the generated persistence catalog): `voice-edge/sync`, `voice-edge/model-event`, `voice-edge/tool-call`, `voice-edge/tool-result`, `voice-edge/finish`.

A mirror session never runs a harness turn, so the first `voice-edge/sync` is its conversation-start marker: it clears `SessionSummary.blank`, keeping the session visible in `session.list` (and the Web session tree) after the current selection moves elsewhere, and it locks the session's agent preset like any started history.

### Restart adoption

The boot/full-key alias tables are in-memory only, so after a host restart a later `/session/sync` probes the persisted sessions for the claimed key's id, then the boot key's, and **resumes** whichever exists instead of creating a fresh same-id session. One conversation therefore stays on one session across restarts: turn-2+ syncs (claiming the strong full key) adopt the turn-1 session bound by the boot key, and continuations resume their own session directly. The boot probe carries the same first-user-line collision semantics as the in-memory alias. Without a session-persistence backend composed there is nothing to probe and every bind creates fresh, exactly as before.

## Configuration

```yaml
- name: voice-edge
  plugin: '@deepseek-ai/dsh-voice-edge'
  config:
    path: /api/voice-edge        # default
    token: replace-with-a-local-secret   # required
    autoApprove: true            # default; see below
    # cwd: /absolute/fallback    # request cwd wins
    # preset: standard           # join this preset; roster default when unset
    # maxBodyBytes: 8388608
    # toolTimeoutMs: 120000
    # maxConversations: 256
```

The composition must also carry `@deepseek-ai/dsh-host-webserver` (the HTTP carrier), an agent-loop provider (`ctx.agents.create` needs the registered factory), `@deepseek-ai/dsh-user-approval` when guarded tools should run, and a session-persistence backend when the mirror should survive restarts.

`preset` joins every conversation agent to an agent preset (resolved id is recorded on the session header) when the composition carries an `agentPresets` service — preset-owned deployments such as the web app expose model-facing tools per session rather than in the host layer, so without the join those agents would see no tools at all. Without the service the config value is ignored: rosterless deployments already expose tools in the host layer. An unknown or broken preset fails the conversation bind with `agent_unavailable` (503).

`autoApprove: true` answers `approval/request` with `allowed-once` **only for agents this bridge created** — Voice Edge turns are non-interactive, so the default fail-closed stance would deny every guarded tool. All other agents delegate to the next answerer unchanged.

## Model Experience

None, as the bridge mirrors an external model loop and assembles no Harness model context; executed tool results return to `voice_edge.py` only.

#### KV Cache effect

None; the Harness agent loop never runs a model for mirror sessions, so no request cache is ever keyed by this plugin.

## Known Limitations and Deferred Work

- The mirrored history projection is bounded (last 50 messages, 4,000 chars per message; event text capped at 16,000 chars), so very old or long turns render shortened in clients reading the mirror.
- Conversations evict from memory by `maxConversations` recency (disposing their agent); requests against an evicted conversation fail with `unknown_conversation` until the next `/session/sync` re-binds it to the same durable session.
