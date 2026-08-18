# @deepseek-ai/dsh-voice-edge

[English](README.md) | 中文

Voice Edge 桥接插件：让外部 `voice_edge.py` 进程把自己的会话绑定到 Harness Session、把模型事件镜像进持久化会话日志，并通过组合内 `webServer` 服务上的令牌鉴权 HTTP 前缀执行 Harness 工具。

## 边界契约

- 插件**从不返回模型上下文**（不返回 messages、系统提示词或组装后的历史）。`voice_edge.py` 拥有模型请求与对客户端可见的输出；Harness Session 只是持久镜像加工具执行宿主。
- 每个会话创建的 Harness Agent 只是 scope/session 容器。插件从不提交 inbox 工作，因此它的 agent loop 不会跑模型。
- Session 标识为 `voice-edge-<sha256(conversation_key)>`；原始 key 不进入路径或外部资源名。

## 端点

所有端点位于 `config.path`（默认 `/api/voice-edge`）之下，要求 `Authorization: Bearer <config.token>`，收发 JSON。

| POST | 用途 | 返回（除确认字段外） |
| --- | --- | --- |
| `/session/sync` | 绑定 `conversation_key`（boot/full key 别名解析到同一 Session），并镜像有界的历史投影 | `tools`：该 Agent 可见的 Harness 工具 schema |
| `/model/event` | 镜像一个外部模型 step（文本、reasoning、tool calls、finish reason） | — |
| `/tool/execute` | 以该会话的 Agent 身份执行一个 Harness 工具（按会话串行） | `tool_result`：`{ isError, text }` |
| `/turn/finish` | 写入 finish 标记并派发 `session/flush` 持久化检查点 | `flushed`：是否有持久化监听器参与 |

成功确认字段：`conversation_key`、`harness_session_id`（诊断用）、`synced`、`sequence`。失败返回 `{ synced: false, error: { message, type } }` 与对应 HTTP 状态码。

## 会话事件

仅日志的镜像事件（合并进 `SessionEventMap`，并登记进生成的持久化目录）：

`voice-edge/sync`、`voice-edge/model-event`、`voice-edge/tool-call`、`voice-edge/tool-result`、`voice-edge/finish`。

镜像会话永不运行 harness turn，因此首个 `voice-edge/sync` 就是它的对话开始标记：它会清除 `SessionSummary.blank`，使会话在当前选中移走后仍保持在 `session.list`（及 Web 会话树）中可见，并且像任何已开始的对话一样锁定会话的 agent preset。

### 重启收养

boot/full-key 别名表只存在于内存，因此宿主重启后，后续的 `/session/sync` 会先按 claimed key 的 id、再按 boot key 的 id 探测已持久化的会话，并**resume** 命中的那个，而不是新建同 id 的新会话。于是一个对话跨重启保持在同一个会话上：turn 2+ 的 sync（claim 强 full key）会收养 turn 1 以 boot key 绑定的会话，续聊则直接 resume 自己的会话。boot 探测的 first-user-line 碰撞语义与内存别名一致。未组合 session-persistence 后端时无从探测，每次绑定都全新创建，行为与之前完全相同。

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

组合还必须携带 `@deepseek-ai/dsh-host-webserver`（HTTP 载体）、一个 agent-loop 提供方（`ctx.agents.create` 需要已注册的 factory）、需要运行受守卫工具时的 `@deepseek-ai/dsh-user-approval`，以及需要镜像跨重启存活时的 session-persistence 后端。

`preset` 在组合携带 `agentPresets` 服务时，把每个会话 Agent 加入一个 agent preset（解析出的 id 记录在 session header 上）——web app 这类 preset 持有的部署按会话暴露模型可见工具，而非放在 host 层；不加入的话这些 Agent 将完全看不到工具。没有该服务时此配置被忽略：无 roster 的部署本就把工具放在 host 层。preset 未知或损坏时，会话绑定以 `agent_unavailable`（503）失败。

`autoApprove: true` 只对**本桥接创建的 Agent** 把 `approval/request` 应答为 `allowed-once`——Voice Edge 的 turn 是非交互的，默认 fail-closed 立场会拒绝所有受守卫工具。其他 Agent 原样委派给下一个应答者。

## 模型体验

无。桥接只镜像外部模型循环，不组装任何 Harness 模型上下文；执行出的工具结果也只返回给 `voice_edge.py`。

#### KV Cache 影响

无。镜像会话的 Harness agent loop 从不跑模型，不存在以本插件为键的请求缓存。

## 已知限制与暂缓事项

- 镜像的历史投影有界（最近 50 条消息、每条 4,000 字符；事件文本上限 16,000 字符），因此在读取镜像的客户端里，过早或过长的轮次会以截断后的内容渲染。
- 会话按 `maxConversations` 最近使用从内存逐出（同时销毁其 agent）；被逐出会话上的请求以 `unknown_conversation` 失败，直到下一次 `/session/sync` 把它重新绑定到同一持久会话。
