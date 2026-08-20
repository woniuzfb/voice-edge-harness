# @deepseek-ai/dsh-voice-edge

English | [中文](README.zh.md)

Voice Edge bridge: lets an external `voice_edge.py` process bind its conversations to Harness sessions, mirror model events into the durable session log, and execute Harness tools — all over a token-authenticated HTTP prefix on the composed `webServer` service.

## Boundary contract

- The plugin **never returns model context** (no messages, system prompts, or assembled history). `voice_edge.py` owns the model request and the client-visible output; the Harness session is a durable mirror plus a tool-execution host.
- **Every mirror append is client-delivered**: the plugin records an event only when `voice_edge.py` explicitly POSTs it. The user turn mirrors the user's fresh turn text — the relay-extracted body of the submitted prompt, without per-turn transport framing (relayed system prose, tool-instruction XML) — plus the user's inline images re-embedded as markdown data URIs (they ride the host's attachment channel to the model, not the text); the plugin never re-extracts or re-parses client messages, so the log cannot drift from what the model received. The plugin's only self-originated log writes are the `voice-edge/tool-call`/`voice-edge/tool-result` pairs of executions it performed.
- The Harness agent created per conversation is a scope/session container only. The plugin never submits inbox work, so the agent loop never runs a model for it.
- Session identity is `voice-edge-<sha256(conversation_key)>`; the raw key never enters paths or external resource names.

## Endpoints

All endpoints live under `config.path` (default `/api/voice-edge`), require `Authorization: Bearer <config.token>`, and accept/return JSON.

| POST | Purpose | Returns (beyond the ack fields) |
| --- | --- | --- |
| `/session/bind` | Bind `conversation_key` (boot/full key aliases resolve to the same session); records nothing | `tools`: Harness tool schemas visible to that agent |
| `/event` | Append one client-delivered mirror event (`voice-edge/sync` = the user's fresh turn text, `voice-edge/model-event` = one external model step, `voice-edge/finish` = turn close, which also dispatches the `session/flush` durability checkpoint) | `flushed` on finish: whether a persistence listener participated |
| `/tool/execute` | Execute one Harness tool as the conversation's agent (serialized per conversation; records the call/result pair itself) | `tool_result`: `{ isError, text }` |

Ack fields on success: `conversation_key`, `harness_session_id` (diagnostic), `synced`, `sequence`. Failures return `{ synced: false, error: { message, type } }` with an HTTP status. `type` values the client cannot deliver (`voice-edge/tool-call`, `voice-edge/tool-result`, unknowns) fail with `unsupported_event` (400).

## Session events

Log-only mirror events (merged into `SessionEventMap`, registered in the generated persistence catalog): `voice-edge/sync`, `voice-edge/model-event`, `voice-edge/tool-call`, `voice-edge/tool-result`, `voice-edge/finish`.

A mirror session never runs a harness turn, so the first `voice-edge/sync` is its conversation-start marker: it clears `SessionSummary.blank`, keeping the session visible in `session.list` (and the Web session tree) after the current selection moves elsewhere, and it locks the session's agent preset like any started history.

### Session titles

Every mirrored session carries the placeholder title `voice-edge` from creation (adopted pre-title sessions gain it on resume): the client's untitled display otherwise falls back to the cwd basename, which names the Harness checkout rather than the conversation surface.

Continue's generateTitle request rides the same conversation as an ordinary fresh user turn — the fixed instruction (`Given the following…` opening, `please reply with a title` inside) with the conversation content inline. While the placeholder stands, the bridge detects that instruction in the mirrored user text and folds the whole turn instead of mirroring it: the turn's `voice-edge/sync` and `voice-edge/model-event`s append nothing (the instruction and the title reply are not conversation content), and at `voice-edge/finish` the last non-empty step text — the model's title reply — is normalized and appended as a `session/title` event (provider `voice-edge`). Once a real title stands — an earlier generation, or an explicit user rename, which pins — detection is skipped entirely and a generateTitle turn mirrors as ordinary content.

### Restart adoption

The boot/full-key alias tables are in-memory only, so after a host restart a later `/session/bind` probes the persisted sessions for the claimed key's id, then the boot key's, and **resumes** whichever exists instead of creating a fresh same-id session. One conversation therefore stays on one session across restarts: turn-2+ binds (claiming the strong full key) adopt the turn-1 session bound by the boot key, and continuations resume their own session directly. A **live agent** on any candidate id — e.g. the Web client resumed the mirrored conversation through apiproxy while the bridge's tables were empty — is re-attached as the binding instead of resumed under (the persistence coordinator refuses to prepare a live session). The boot probe carries the same first-user-line collision semantics as the in-memory alias. Without a session-persistence backend composed there is nothing to probe and every bind creates fresh, exactly as before.

### Durable delete

A durable delete (`workspace.deleteSession`) structurally disposes the conversation's agent through the agent registry before removing the log. The bridge listens for the resulting `session/disposed` and drops its conversation record, so the next `/session/bind` with the same key creates a fresh session — no stale agent reference, no adoption of the deleted log.

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

- Mirror texts are stored verbatim with no length caps; `maxBodyBytes` (default 8 MiB) is the single size bound, enforced at the HTTP wire. A fresh turn whose re-embedded inline images push the event past `maxBodyBytes` mirrors nothing for that turn (fail-open) — raise the bound in cordis.yml if you mirror image-heavy turns.
- Conversations evict from memory by `maxConversations` recency (disposing their agent); requests against an evicted conversation fail with `unknown_conversation` until the next `/session/bind` re-binds it to the same durable session.
