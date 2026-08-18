# Agent Note: voice-edge conversation agents join an agent preset

Status: implemented

English | [中文](2026-08-18-voice-edge-joins-agent-preset.zh.md)

## Problem

Every conversation the voice-edge bridge binds creates its Harness agent through `ctx.agents.create` with no preset join. Whether that agent sees tools depends on which layer of the deployment owns them: rosterless compositions (the base-only profile) expose model-facing tool rows in the host layer, where any agent sees them, but preset-owned compositions — the web app is the shipped one — disable those rows and expose tools per session through a preset standing mount. A voice-edge agent created outside the presets system joined nothing, so `session/sync` answered `tools: []` on `dsh web` and `tool/execute` had nothing to execute. The mirror half of the bridge worked; the tool half was silently absent, which is the worst shape for a bridge whose caller cannot tell an empty roster from a miscomposed one.

## Decision

`createConversation` composes its agent exactly the way [api-proxy](../../../../packages/host/apiproxy/src/api-proxy.ts) does for web sessions: when `ctx.get('agentPresets')` returns a roster, the configured preset (config `preset`, roster default when unset) is resolved BEFORE creation so the session header can snapshot `meta.agentPreset`, and the factory `setup` callback mounts it on the unpublished agent scope, so a broken preset rolls the whole creation back into the existing 503 `agent_unavailable` answer rather than publishing a half-composed agent. Without the service nothing changes — the rosterless deployment already shows tools through the host layer, which is the pre-presets behavior and remains correct there.

The one deliberate difference from api-proxy: voice-edge never re-resolves a preset from the log on rebind. A conversation's agent is adopted as-is when it exists, and recreated from the current config when it does not, matching the bridge's existing `cwd` stance (request/config wins over persisted state) rather than the gateway's session-continuity stance. Voice-edge sessions are mirrors whose history is not produced under a preset's tool set, so continuity would buy nothing.

Fixing this surfaced a latent registration gap: `packages/host/voice-edge` was missing from `tsconfig.host.json` references, so the package's sources had never been part of the host aggregate's file list — incremental build info hid it, and the generated persistence catalog plus `KNOWN_SESSION_EVENT_TYPES` had silently omitted every `voice-edge/*` event. Adding the reference also brought the generated catalog up to date in the same change.

## Alternatives considered

**Leave the join to the deployment via a base-only profile.** Works — the dedicated `voice` profile demonstrates it — but it makes the web composition second-class forever and splits one bridge across two processes just to execute tools. Rejected: the presets seam exists precisely so agent creators join compositions, and voice-edge is an agent creator.

**Mount the preset outside `setup`, after creation.** Rejected by the presets contract: the factory's unpublished `setup(agentCtx)` is the one supported call site, because only there does a rejected composition roll back the creation. Post-publication mounting would leave a published session whose capabilities half-installed.

**Default `preset` to a fixed id instead of the roster default.** Rejected: hardcoding a roster name in a plugin would fail on every deployment that ships different presets; `undefined → roster default` is the same resolution rule the gateway uses and keeps one source of defaulting.

## Consequences

- On `dsh web`, `session/sync` now returns the preset's tool catalog and `tool/execute` runs real tools for voice conversations; the web profile's patch needs no `preset` value unless it wants a non-default preset.
- Rosterless deployments are byte-for-byte unchanged in behavior; the new config field is inert without an `agentPresets` service.
- A voice-edge session header now records `agentPreset` whenever a roster composed it, which makes those sessions legible to preset-aware tooling (the sidebar, `resolveSessionPreset` readers).
- The persistence catalog, `KNOWN_SESSION_EVENT_TYPES`, and the host package README now list the voice-edge events and package row; regenerating them is part of this change, not a follow-up.
- `dsh-voice-edge` gains a `dsh-agent-presets` peer dependency (type-only edge); profile installs are unaffected because the healed `~/.dsh/profiles/node_modules` closure already links it.
