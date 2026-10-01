# Agent Note: Durable session delete across the persistence–registry–RPC–UI chain

Status: implemented

English | [中文](2026-08-19-durable-session-delete.zh.md)

## Problem

Archive ([session archive](../../archived/feature/2026-07-31-session-archive-global-set.md)) only hides a session: the durable log stays on disk forever and no product surface can remove it. Reclaiming disk or eliminating a transcript meant hand-deleting directories under the sessions root outside the product, and a hand-deleted session leaves stale registry state behind — archive-set membership and workspace accounting slots — that the next restart still sees. The session row menu carried no destructive entry at all; the original archive decision had consumed the visual-only "Delete session" placeholder for its non-destructive action.

## Decision

**Deletion is a first-class chain: persistence deletes the bytes, the registry deletes references after the log, one RPC plus a reused host frame carry it over the wire, and the UI confirms before committing.**

- Persistence: `SessionPersistence.delete(id)` reaches each backend's `deleteStored`. The JSONL backend removes the per-session directory under every project scope (recursive and forced — idempotent, and the directory's session-local artifacts go with it); the SQLite backend deletes the `sessions` row with the `events` foreign key cascading.
- Registry (`workspaceRegistry.deleteSession`, riding `enqueueOperation`): a live session rejects with `WorkspaceLiveSessionError`; the durable log is deleted first, so a mid-way failure leaves the log recoverable through persistence rather than a listed session with no log. Reference cleanup follows — header index, path caches, every workspace entity's accounting slot, archive-set membership — then `workspace/session-deleted` is emitted. An unknown id resolves instead of failing: stale references clear under the same call (delete is idempotent at the registry API).
- Ownership boundary for live sessions: `AgentHandle.dispose()` is a capability, and the api gateway (`ensureSession`) originally discarded it after creation — no product path could tear a live session down. The first attempt kept the gateway's own handles and disposed only those, which still left every other creator (voice-edge bridge, subagent parents) undeletable. The landed rule: the AgentRegistry is the factory provider's host, so it holds the same structural teardown right the `AgentHandle` contract already grants the provider ("provider unload stops and drains every live handle it made"); `AgentRegistry.dispose(id)` exposes exactly that right. The registry records every handle `create`/`resume` mints, `workspace.deleteSession` structurally disposes any live agent through it regardless of which component minted it, and a normal consumer lifecycle still runs through the handle its owner keeps. Only a bare live session with no factory-minted handle answers `session-live`.
- Wire: `workspace.deleteSession({sessionId}) → {deleted: true}` with `session-live` as the business rejection. The registry event reuses the existing `host/session-removed` frame — a durable deletion is not a live-session disposal, but the client effect (the row leaves the list and the conversation view) is identical, so the broadcast leg needed no new frame type.
- Client runtime: the workspaces manager adds the call; the sessions manager's existing `host/session-removed` fold drops the row in this and every other tab, and the projection sweep clears a deleted current selection into the New Session view state under the same one-rule policy as archive.
- UI: the session row menu gains a danger-styled delete item; the confirmation modal states irreversibility, blocks duplicate submission while pending, and surfaces failures inline.

## Alternatives considered

**Archive plus a retention sweeper.** Rejected: hidden-but-kept answers a policy question; the actual ask is the bytes gone now, on the user's command.

**Soft delete (tombstone with a later purge).** Rejected: no undo requirement exists to pay the tombstone's complexity for, and a half-deleted row invites exactly the stale-reference confusion this chain exists to eliminate.

**Registry-first ordering (drop references, then delete the log).** Rejected: a mid-way failure then leaves a listed session whose log is already gone; log-first fails safe into "recoverable orphan" instead of "listed ghost".

**A dedicated `host/session-deleted` frame.** Rejected: the client effect of a durable delete and a live-session disposal is the same row removal; one frame per client-visible fact keeps the client fold single-source.

## Consequences

Deleting is irreversible and every layer says so: the confirmation names it, and unknown ids resolve rather than error so retrying after a partial hand-deletion repairs the registry. Deleting the currently open session — Web or voice-edge — is one click, not a two-step dance: the structural dispose runs inside the call; only a bare live session without a factory-minted handle answers `session-live` as an inline dialog error. Delete shares `enqueueOperation` with archive and every registry write, so the two operations cannot interleave. The log-first order means a failed delete leaves the session fully intact and retryable. Registry tests pin the ordering (accounting still lists the session when its log goes), the mid-way failure, live rejection, and stale-archive cleanup after restart; the agent registry tests pin dispose's one-shot semantics; the apiproxy tests pin the dispose-then-delete flow over both a gateway-owned and a foreign-minted (voice-edge style) live session, the bare-session rejection, and the frame; the voice-edge spec pins the bridge side — its `session/disposed` listener drops the bound conversation, so the next bind recreates fresh instead of holding a stale agent or adopting the deleted log; UI tests pin the confirmation flow and duplicate-submission blocking.
