# Agent Note: voice-edge folds Continue's generateTitle turn into session/title

Status: implemented

English | [中文](2026-08-19-voice-edge-folds-continue-generate-title.zh.md)

## Problem

Two defects in the mirrored-session display. First, every voice-edge session shows `deepseek-harness` in the Web session tree: the client's untitled-display fallback is the cwd basename, which names the Harness checkout rather than the conversation surface, and a mirror session never earns a title of its own (the title service derives from `user/message` events the mirror never writes). Second, Continue's generateTitle request rides the bound conversation as an ordinary fresh user turn — the fixed instruction with the conversation content inline — so the bridge mirrored its instruction as a user bubble and the model's title reply as an assistant bubble: title noise as conversation content.

## Decision

Both move into the bridge, `voice_edge.py` untouched. Every conversation gains the placeholder `session/title` `voice-edge` (source `fallback`) at creation, and adopted pre-title sessions gain it on resume. A generate-title turn is detected in the mirrored user text — `Given the following` opening plus `please reply with a title` inside — and folds instead of mirroring: the turn's `voice-edge/sync` and `voice-edge/model-event`s append nothing (the ack protocol is unchanged, sequence numbers still advance), and at `voice-edge/finish` the last non-empty step text is normalized (`normalizeSessionTitle`, 200-byte budget) and appended as `session/title` with source `{ kind: 'provider', provider: 'voice-edge' }`.

A generated title replaces only the placeholder: once a real title stands — an earlier generation, or an explicit user rename, which pins — detection is skipped entirely and later generateTitle turns mirror as ordinary content. An ordinary sync supersedes a title turn that never finished, so an aborted generation cannot swallow the next real turn.

## Alternatives considered

**Filter title turns in the UI projection.** Rejected: the events would still be durable log content — session replay, export, and every future consumer would keep seeing the instruction and reply as conversation turns, and "model-visible ⟺ logged" would carry bubbles no client should render.

**Have voice_edge.py skip mirroring title requests.** Rejected: the client owns the mirror, but the bridge owns the session surface (placeholder title, rename protection); splitting one feature across the wire protocol and the plugin would need a new "this turn is special" event type for what the instruction text already states.

**Reuse the title service's `rename()`.** Rejected: `rename` writes the `user` source, which pins — the model's reply is not a user decision, and pinning would block nothing today but misstate the source to every future title consumer.

## Consequences

voice-edge takes a runtime dependency on `@deepseek-ai/dsh-session-title` (normalize + provider id, both pure). The placeholder title means a mirror session is never "untitled", so the cwd-basename fallback no longer applies to it. `bind` is still content-free in the mirror sense: the only event a fresh session carries is the placeholder title. Detection is prefix-based on the mirrored user text: a user genuinely composing a prompt that starts `Given the following` and contains `please reply with a title` would fold that turn — accepted as the cost of recognizing a fixed client instruction with no marker field.

Covered by `voice-edge.spec.ts`: placeholder title at bind, fold-with-title (sync/model-event counts unchanged, title lands as provider source), user rename pins against generation, and an earlier generated title survives a second generateTitle turn.
