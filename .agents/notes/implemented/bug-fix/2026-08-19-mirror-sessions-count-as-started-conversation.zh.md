# Agent Note: 镜像会话视为已开始对话

Status: implemented

[English](2026-08-19-mirror-sessions-count-as-started-conversation.md) | 中文

## Problem

会话列表的 blank 位原义是"日志中没有 `turn/start`"。voice-edge 会话是纯镜像：模型循环运行在 `voice_edge.py` 侧，Harness 日志只记录 `voice-edge/*` 事件，永远不会运行 Harness turn——因此每个镜像会话永远 `blank: true`。客户端会把非当前的 blank 会话从会话树中隐藏（blank 会话是可复用的"New Session"槽位），于是恢复出来的镜像会话在选择移走的那一刻就消失：重启后作为 `current` 可见，点到别处一次就没了。同一判定还门控 `agentPreset.select` 的仅限空白的重组。

宿主有两条计算路径——`sessionBlank()`（用于 `host/session-added` 帧与 preset 锁）和 `applySessionListMetadata` 折叠（用于 `session.list` 的实时与冷探测）——都只看 `turn/start`。

## Decision

一个共享判定 `CONVERSATION_START_EVENTS` 同时列出两个标记：`turn/start`（一次 Harness 模型循环 turn）与 `voice-edge/sync`（每个镜像 turn 的首个事件——`/session/sync` 是强制入口，其他端点缺它一律 409，因此已绑定的镜像必有该事件）。两条 blank 路径与 preset 锁都读它。`dsh-host-apiproxy` 对 `@deepseek-ai/dsh-voice-edge/types` 增加一个仅类型的依赖以完成 `SessionEventMap` 合并，沿用该包既有的 side-effect 类型导入。

## Alternatives considered

**由 voice-edge 插件自行追加 `turn/start`。** 否决：turn 是一次 Harness 模型循环执行；镜像会话从不运行，伪造它会让所有按 turn 划界的消费方（分页、投影、SDK）去期待永远不会到来的 `turn/end`、usage 与 message 事件。

**提供注册式扩展点，让镜像插件声明各自的开场事件。** 否决：镜像插件只有一个；注册表是无第二消费方的投机面（仓库规则：要求现存的归属与需求）。

**匹配任意 `voice-edge/*` 事件。** 否决：精确标记是绑定会话的那次 sync；后续镜像事件（模型步骤、工具调用、finish）都保证发生在某个 sync 之后，而前缀匹配会静默接受未来出现的非对话簿记事件。

## Consequences

镜像会话现在出现在 `session.list` 中，并在选中移走后留在 Web 会话树里；首个 sync 绑定后 `agentPreset.select` 以 `agent-preset-locked` 拒绝重组，与任何已开始的对话一致。缓存的冷 `blank: true` 行自行愈合：冷探测重读并重折叠，超限工件仍按原逻辑判为可见。`host/session-added` 帧在创建时仍携带 `blank: true`（sync 发生在创建之后），不变。

覆盖：`api-proxy-blank.spec.ts`（无 turn 时镜像 sync 清除 blank）与 `api-proxy-agent-preset.spec.ts`（镜像 sync 锁定重组）。
