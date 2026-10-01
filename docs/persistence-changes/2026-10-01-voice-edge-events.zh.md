---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-01-voice-edge-events

[English](2026-10-01-voice-edge-events.md) | 中文

## 概述

登记 Voice Edge 镜像会话事件类型。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有日志不包含此类事件，保持有效。新事件类型表示外部 Voice Edge 会话镜像事件（sync、model-event、tool-call、tool-result、finish），仅在启用 Voice Edge 集成时写入。旧版本读取器保留或忽略未知日志事件。

<a id="verification"></a>
## 验证

vitest run packages/host/voice-edge packages/client/ui-voice-edge：23 个测试通过。typecheck 通过。

<a id="dev-note"></a>
## 开发备注

无。
