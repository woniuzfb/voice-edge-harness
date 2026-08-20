# @deepseek-ai/dsh-client-ui-voice-edge

English | [中文](README.zh.md)

Chat-view rendering for the Voice Edge mirror. The Host bridge (`@deepseek-ai/dsh-voice-edge`) records voice_edge.py turns as log-only `voice-edge/*` session events; without this plugin no `ConversationNodeDefinition` matches them and a bridged conversation renders blank in the Web client.

## Node mapping

| Session event(s) | Chat row |
| --- | --- |
| `voice-edge/sync` | `voice-edge-user` — right-aligned user bubble rendering the mirrored turn text literally (user input is not Markdown), with the mirror's re-embedded inline images (markdown data URIs) displayed through the shared raster gate; malformed/truncated payloads fall back to alt text |
| `voice-edge/model-event` | `voice-edge-assistant` — mirrored model step (literal reasoning block + assistant-Markdown text, so inline `data:image` model output renders as images; malformed/truncated payloads fall back to alt text); text-less tool steps render nothing |
| `voice-edge/tool-call` + `voice-edge/tool-result` | `voice-edge-tool` — one Harness tool row per `callId`, settled from running to completed/error by the paired result |

`voice-edge/finish` carries no renderable content and is deliberately unmatched. Ids derive from durable payload only (`event.seq`, `callId`), so replay, pagination, and live append all build the same rows.

User and assistant bubbles with text carry an action row pinned outside the block's bottom-right, always visible: copy writes the mirrored text verbatim through the shared clipboard helper (conversation-message check swap as success feedback), and user rows additionally carry chevron hops that smooth-scroll to the previous/next user message — the hop walks the rows this module stamps with `data-voice-edge-user`, so it stays correct across replay and pagination, and is a no-op at the ends of the flow. Each turn opens with its user row, which carries an extra top margin over the chat column's uniform row gap so a new turn reads as a break, not just another row.

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
