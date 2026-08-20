# Agent Note: Mirror sessions count as a started conversation

Status: implemented

English | [中文](2026-08-19-mirror-sessions-count-as-started-conversation.zh.md)

## Problem

Session-list blankness meant "no `turn/start` in the log". A voice-edge session is a pure mirror: the model loop runs in `voice_edge.py`, the Harness log records only `voice-edge/*` events, and no Harness turn ever runs — so every mirror session stayed `blank: true` forever. Clients hide non-current blank sessions from the session tree (blank sessions are reusable "New Session" slots), so a restored mirror session vanished the moment the selection moved elsewhere: visible as `current` after a restart, gone after one click elsewhere. The same predicate also gates `agentPreset.select`'s blank-only recomposition.

Two host paths computed the bit — `sessionBlank()` for the `host/session-added` frame and the preset lock, and the `applySessionListMetadata` fold for `session.list` (live and cold-probed) — both keyed on `turn/start` alone.

## Decision

One shared predicate, `CONVERSATION_START_EVENTS`, names both markers: `turn/start` (a Harness model-loop turn) and `voice-edge/sync` (the user-turn event the client delivers once per mirrored turn — `/session/bind` is the mandatory entry point every other endpoint 409s without, and the client delivers the sync event on every turn). Both blankness paths and the preset lock read it. `dsh-host-apiproxy` takes a type-only dependency on `@deepseek-ai/dsh-voice-edge/types` for the `SessionEventMap` merge, following the package's existing side-effect type imports.

## Alternatives considered

**Append `turn/start` from the voice-edge plugin.** Rejected: a turn is one Harness model-loop execution; a mirror session never runs one, and faking it would make every turn-scoped consumer (pagination, projections, SDKs) expect `turn/end`, usage, and message events that never arrive.

**A registration extension point where mirror plugins declare their start event.** Rejected: exactly one mirror plugin exists; the registry would be speculative surface with no second consumer (repo rule: require a current owner and need).

**Match any `voice-edge/*` event.** Rejected: the precise marker is the sync that binds the conversation; later mirror events (model steps, tool calls, finish) are all guaranteed to follow one, and a prefix match would silently accept future non-conversation bookkeeping events.

## Consequences

Mirror sessions now appear in `session.list` and stay in the Web session tree after the selection moves; `agentPreset.select` refuses them with `agent-preset-locked` once the first sync binds, same as any started conversation. Cached cold `blank: true` rows self-heal: the cold probe re-reads and re-folds, and oversized artifacts resolve visible as before. The `host/session-added` frame still carries `blank: true` at creation (the sync lands after creation), unchanged.

Covered by `api-proxy-blank.spec.ts` (mirror sync clears blank with no turn) and `api-proxy-agent-preset.spec.ts` (mirror sync locks recomposition).
