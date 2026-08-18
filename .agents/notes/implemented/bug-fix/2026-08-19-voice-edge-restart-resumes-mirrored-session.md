# Agent Note: Voice Edge restart resumes the mirrored session

Status: implemented

English | [中文](2026-08-19-voice-edge-restart-resumes-mirrored-session.zh.md)

## Problem

The bridge's boot/full-key alias tables live only in memory. After a host restart they are empty, so a later `/session/sync` misses the lookup and falls through to `agents.create` under the claimed key's derived session id — with two consequences. First, a conversation whose turn 1 bound `sha256(boot_key)` and whose turn 2+ claims `full_key` split into two sessions across the restart. Second, and worse: for a conversation that already had `sha256(full_key)` on disk, the create minted a fresh seq-0 session with the same id; every request on it succeeded in memory, but `turn/finish` dispatches `session/flush` and the persistence backend refuses to materialize over an existing committed log — the whole mirrored turn failed with 500 and its events never became durable. `voice_edge.py` presents all three keys on every sync ([probe site](../../../../packages/host/voice-edge/src/index.ts)), so the information needed to recover the binding is already on the wire; only the harness side forgot it.

## Decision

On a lookup miss, `createConversation` probes the durable store (`sessionPersistence.list()`) for the claimed key's session id, then the boot key's, and resumes whichever exists via `agents.resume` (with the same preset setup the create path mounts) instead of creating a fresh same-id session. Turn-2+ syncs therefore adopt the turn-1 session bound by the boot key; continuations resume their own session directly. The probe order prefers the strong identity, so sessions already split by the old behavior stay on their full-key session (the split is historical damage, but no turn is ever lost again). The boot probe deliberately carries the same first-user-line collision semantics as the in-memory alias: where the pre-restart alias lookup would have merged two conversations sharing a first user line, adoption merges them too — no new risk class. Without a persistence backend composed there is nothing to probe and every bind creates fresh, unchanged.

## Alternatives considered

**Persist the alias table (e.g. a sidecar file or a harness-side key map).** Rejected: it duplicates information the durable session log already carries (`voice-edge/sync` records `bootKey`/`fullKey`) and adds a second artifact to keep consistent with eviction and teardown.

**Scan session logs for recorded keys on miss.** Rejected: `persistence.list()` plus deterministic `sha256(key)` derivation answers the same question without reading event bodies, stays O(headers), and works for sessions whose sync events predate any key recording.

**Have `voice_edge.py` re-supply the binding explicitly.** Rejected: it already supplies every key it knows on every sync; making the client responsible for harness-side restart recovery crosses the bridge's HTTP contract for no gain.

## Consequences

One conversation stays on one session across restarts, and a pre-existing durable session is never re-created under the same id, so the backend's materialization rejection path can no longer lose a mirrored turn. `agents.resume` rebuilds the preset composition through the same setup callback as create, so adopted sessions keep their tools. Known residual: adoption binds the conversation to the boot-derived session id permanently (aliases handle routing thereafter), and a historically split conversation does not merge retroactively.
