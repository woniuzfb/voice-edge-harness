---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-01-voice-edge-events

English | [中文](2026-10-01-voice-edge-events.zh.md)

## Summary

Registers Voice Edge mirror session event types.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-01-voice-edge-events
baseline: false
changes:
  - root: "event:voice-edge/finish"
    previous: null
    after: "7c70350bd3e0c73ccf976f31990249e71378a59a2ebb9d4b354b79337c3f1a0b"
    decision: same-version
  - root: "event:voice-edge/model-event"
    previous: null
    after: "e10c756e62e22ea8a22cd483ab32adc421c1fd323d6b200026810735b16de9ce"
    decision: same-version
  - root: "event:voice-edge/sync"
    previous: null
    after: "4883eb1f153a6888dee84fd2bb8ee45ed696054172e1052eadaa34c857262f6a"
    decision: same-version
  - root: "event:voice-edge/tool-call"
    previous: null
    after: "c3b93a9f1fb744504e76ddebd11b5302e7558ce0f5bd7ceac488b12c0cc709b1"
    decision: same-version
  - root: "event:voice-edge/tool-result"
    previous: null
    after: "ee04d5435e628add44ad86720d28f6108abdebf2fda958094067d39563bec6c6"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing logs contain no such events and remain valid. The new event types represent external Voice Edge session mirror events (sync, model-event, tool-call, tool-result, finish) and are only written when Voice Edge integration is active. Older readers preserve or ignore unknown log events.

<a id="verification"></a>
## Verification

vitest run packages/host/voice-edge packages/client/ui-voice-edge: 23 tests passed. typecheck passed.

<a id="dev-note"></a>
## Dev Note

None.
