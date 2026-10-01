---
description: "Voice Edge 桥接插件，允许外部 voice_edge.py 进程经 HTTP 绑定会话、镜像模型事件并执行 Harness 工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-voice-edge

[English](README.md) | 中文

## 概述

使用本包通过 HTTP 将外部 `voice_edge.py` 进程与 DeepSeek Harness 桥接。它允许外部对话绑定到 Harness 会话、将客户端交付的模型轮次镜像到持久会话日志中，并以该会话 Agent 身份执行 Harness 工具。该桥接从不返回模型上下文或提交 agent loop 轮次；会话标识使用哈希保护，所有端点均要求令牌鉴权。

## 目录

- [边界契约](#boundary-contract)
- [端点](#endpoints)
- [会话事件](#session-events)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="boundary-contract"></a>
## 边界契约

- 插件**从不返回模型上下文**（不返回 messages、系统提示词或组装后的历史）。`voice_edge.py` 拥有模型请求与对客户端可见的输出；Harness Session 只是持久镜像加工具执行宿主。
- **每条镜像 append 都由客户端显式交付**：只有 `voice_edge.py` 显式 POST 时插件才记录事件。user turn 镜像的是用户的新鲜 turn 正文——提交给外部模型的 prompt 经 relay 提取的 body，不含每轮传输框架（中继的系统 prose、工具指令 XML）——外加用户的内联图（它们经宿主附件通道而非正文到达模型，此处重建为 markdown data URI）；插件从不重新提取、重新解析客户端 messages，日志因此不会偏离模型实际收到的内容。插件自身发起的日志写入只有它执行的工具的 `voice-edge/tool-call`/`voice-edge/tool-result` 成对事件。
- 每个会话创建的 Harness Agent 只是 scope/session 容器。插件从不提交 inbox 工作，因此它的 agent loop 不会跑模型。
- Session 标识为 `voice-edge-<sha256(conversation_key)>`；原始 key 不进入路径或外部资源名。

-----

<a id="endpoints"></a>
## 端点

所有端点位于 `config.path`（默认 `/api/voice-edge`）之下，要求 `Authorization: Bearer <config.token>`，收发 JSON。

| POST | 用途 | 返回（除确认字段外） |
| --- | --- | --- |
| `/session/bind` | 绑定 `conversation_key`（boot/full key 别名解析到同一 Session）；不记录任何事件 | `tools`：该 Agent 可见的 Harness 工具 schema |
| `/event` | append 一条客户端交付的镜像事件（`voice-edge/sync` = 用户的新鲜 turn 正文，`voice-edge/model-event` = 一个外部模型 step，`voice-edge/finish` = turn 收尾，同时派发 `session/flush` 持久化检查点） | finish 时 `flushed`：是否有持久化监听器参与 |
| `/tool/execute` | 以该会话的 Agent 身份执行一个 Harness 工具（按会话串行；call/result 对由它自己记录） | `tool_result`：`{ isError, text }` |

成功确认字段：`conversation_key`、`harness_session_id`（诊断用）、`synced`、`sequence`。失败返回 `{ synced: false, error: { message, type } }` 与对应 HTTP 状态码。客户端不能交付的 `type`（`voice-edge/tool-call`、`voice-edge/tool-result` 及未知值）以 `unsupported_event`（400）失败。

-----

<a id="session-events"></a>
## 会话事件

仅日志的镜像事件（合并进 `SessionEventMap`，并登记进生成的持久化目录）：

`voice-edge/sync`、`voice-edge/model-event`、`voice-edge/tool-call`、`voice-edge/tool-result`、`voice-edge/finish`。

镜像会话永不运行 harness turn，因此首个 `voice-edge/sync` 就是它的对话开始标记：它会清除 `SessionSummary.blank`，使会话在当前选中移走后仍保持在 `session.list`（及 Web 会话树）中可见，并且像任何已开始的对话一样锁定会话的 agent preset。

### 会话标题

每个镜像会话从创建起就携带占位标题 `voice-edge`（收养的无标题旧会话在 resume 时补上）：否则客户端对无标题会话的显示会回退到 cwd basename，那命名的是 Harness 检出目录而非这个对话界面。

Continue 的 generateTitle 请求与普通新用户轮走同一对话——固定指令（以 `Given the following…` 开头、内含 `please reply with a title`）后内联对话内容。占位符仍在时，桥接在镜像的用户文本中识别该指令，并折叠整轮而非镜像它：该轮的 `voice-edge/sync` 与 `voice-edge/model-event` 不追加任何事件（指令与标题回复不是对话内容），`voice-edge/finish` 时把最后一个非空 step 文本——模型的标题回复——归一化后作为 `session/title` 事件（provider `voice-edge`）追加。一旦真实标题成立——早先的生成，或显式的用户改名（会 pin）——检测被整体跳过，generateTitle 轮按普通内容镜像。

### 重启收养

boot/full-key 别名表仅保存在内存中，因此在宿主重启后，后续的 `/session/bind` 会依次在已持久化的会话中探测所声明 key 的 id 及 boot key 的 id，并**恢复（resume）**存在的那一个，而不是新建一个同 id 会话。因此一次对话在重启后仍停留在同一个会话上：第 2 轮及以后的绑定（声明强 full key）收养由 boot key 绑定的第 1 轮会话，后续轮次直接恢复它们自己的会话。在任一候选 id 上的**活动 Agent**——例如 Web 客户端在桥接表为空时通过 apiproxy 恢复了镜像对话——将被重新关联为该绑定，而不是在其下重复恢复（持久化协调器拒绝准备活动会话）。boot 探测携带与内存别名相同的第一行用户文本冲突语义。若未组合会话持久化后端，则无需探测，每次绑定都像以前一样新建。

### 真删

持久删除（`workspace.deleteSession`）在移除日志前先通过 agent registry 结构性销毁该对话的 Agent。桥接监听由此产生的 `session/disposed` 并丢弃其对话记录，使随后使用相同 key 的 `/session/bind` 创建全新会话——无陈旧 agent 引用，亦不收养已删除的日志。

-----

<a id="configuration"></a>
## 配置

```yaml
- name: voice-edge
  plugin: '@deepseek-ai/dsh-voice-edge'
  config:
    path: /api/voice-edge        # default
    token: replace-with-a-local-secret   # required
    autoApprove: true            # default; see below
    # cwd: /absolute/fallback    # request cwd wins
    # preset: standard           # join this preset; roster default when unset
    # maxBodyBytes: 8388608
    # toolTimeoutMs: 120000
    # maxConversations: 256
```

该组合还必须包含 `@deepseek-ai/dsh-host-webserver`（HTTP 承载层）、一个 agent-loop 提供者（`ctx.agents.create` 需要注册的工厂）、在需要运行受守卫工具时的 `@deepseek-ai/dsh-user-approval`，以及在镜像需跨重启持久时需要的会话持久化后端。

当组合包含 `agentPresets` 服务时，`preset` 将每个对话 Agent 加入一个 agent preset（解析后的 id 记录在 session header 上）——由 preset 拥有的部署（如 Web 应用）按会话而非在 host 层暴露面向模型的工具，因此若不加入，这些 Agent 将根本看不到任何工具。没有该服务时配置值被忽略：无 roster 部署已在 host 层暴露工具。未知或损坏的 preset 会导致对话绑定以 `agent_unavailable`（503）失败。

`autoApprove: true` **仅对本桥接创建的 Agent** 以 `allowed-once` 应答 `approval/request`——Voice Edge 轮次是非交互式的，因此默认的 fail-closed 策略会拒绝所有受守卫工具。所有其他 Agent 的请求原样委托给下一个应答者。

-----

<a id="model-experience"></a>
## 模型体验

无——该桥接镜像外部模型循环，不组装任何 Harness 模型上下文；执行的工具结果仅返回给 `voice_edge.py`。

#### KV Cache 影响

无；Harness agent loop 从不为镜像会话运行模型，因此该插件从不为任何请求 cache 建 key。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- 镜像文本原样存储，无长度上限；`maxBodyBytes`（默认 8 MiB）是唯一的尺寸界限，在 HTTP 线路上强制执行。新鲜轮次如果重建的内联图像将事件推过 `maxBodyBytes`，则该轮次不镜像任何内容（fail-open）——如果镜像大量图像轮次，请在 cordis.yml 中调高该界限。
- 对话根据 `maxConversations` 最近最少使用从内存中逐出（销毁其 Agent）；针对已逐出对话的请求将以 `unknown_conversation` 失败，直到下一次 `/session/bind` 将其重新绑定到同一持久会话。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
