# @deepseek-ai/dsh-client-ui-voice-edge

English | [中文](README.zh.md)

Chat-view rendering for the Voice Edge mirror. The Host bridge (`@deepseek-ai/dsh-voice-edge`) records voice_edge.py turns as log-only `voice-edge/*` session events; without this plugin no `ConversationNodeDefinition` matches them and a bridged conversation renders blank in the Web client.

## Node mapping

| Session event(s) | Chat row |
| --- | --- |
| `voice-edge/sync` | `voice-edge-user` — right-aligned user bubble carrying the latest user message of the synced projection |
| `voice-edge/model-event` | `voice-edge-assistant` — mirrored model step (optional reasoning block + text); text-less tool steps render nothing |
| `voice-edge/tool-call` + `voice-edge/tool-result` | `voice-edge-tool` — one Harness tool row per `callId`, settled from running to completed/error by the paired result |

`voice-edge/finish` carries no renderable content and is deliberately unmatched. Ids derive from durable payload only (`event.seq`, `callId`), so replay, pagination, and live append all build the same rows.

## Composition

The package declares its browser half through `dsh.client` in package.json; the Web bundle mounts it by id:

```yaml
- id: ui-voice-edge
  name: '@deepseek-ai/dsh-client-ui-voice-edge'
```

## Model Experience

None, as this package only renders a mirror of another surface's model stream; it registers no prompts, tools, messages, or provider requests.

#### KV Cache effect

None; the package never assembles model input.

## Known Limitations and Deferred Work

- The mirror is read-only: no retry, branch, or feedback actions on mirrored rows.
- The synced projection is bounded by the Host bridge (last 50 messages, truncated text), so very old content may render shortened.
