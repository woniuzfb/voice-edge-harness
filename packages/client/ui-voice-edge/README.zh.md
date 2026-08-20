# @deepseek-ai/dsh-client-ui-voice-edge

[English](README.md) | 中文

Voice Edge 镜像的会话视图渲染。Host 桥（`@deepseek-ai/dsh-voice-edge`）把 voice_edge.py 的轮次记录为仅日志的 `voice-edge/*` 会话事件；没有这个插件，就没有任何 `ConversationNodeDefinition` 匹配它们，桥接会话在 Web 客户端里渲染为空白。

## 节点映射

| 会话事件 | 会话行 |
| --- | --- |
| `voice-edge/sync` | `voice-edge-user`——右对齐用户气泡，按字面渲染镜像的 turn 正文（用户输入不是 Markdown），其中镜像重建的内联图（markdown data URI）经共享的栅格门禁显示为图片；畸形/被截断的载荷回落到 alt 文本 |
| `voice-edge/model-event` | `voice-edge-assistant`——镜像的模型 step（字面思考块 + assistant Markdown 文本，行内 `data:image` 模型输出渲染为图片；畸形/被截断的载荷回落到 alt 文本）；无文本的工具 step 不渲染 |
| `voice-edge/tool-call` + `voice-edge/tool-result` | `voice-edge-tool`——每个 `callId` 一行 Harness 工具行，由配对结果从执行中落定到完成/失败 |

`voice-edge/finish` 没有可渲染内容，刻意不匹配。所有 id 只从持久化 payload 派生（`event.seq`、`callId`），因此重放、翻页与实时追加产出的行完全一致。

带文本的用户与助手气泡在块外右下角携带始终可见的操作行：复制经共享剪贴板辅助函数原样写入镜像文本（成功反馈沿用会话消息的对勾切换）；用户行额外携带箭头跳跃按钮，平滑滚动到上一条/下一条用户消息——跳跃在本模块打上 `data-voice-edge-user` 标记的行之间游走，因此在重放与翻页下都保持正确，且在流的两端为 no-op。每轮以其用户行开头，该行在聊天列统一行距之上携带额外顶部间距，使新轮读起来是一次断开，而不只是又一行。

## 组合

包通过 package.json 的 `dsh.client` 声明浏览器半边；Web bundle 按 id 挂载：

```yaml
- id: ui-voice-edge
  name: '@deepseek-ai/dsh-client-ui-voice-edge'
```

## 模型体验

无——本包只是渲染另一个表面模型流的镜像；不注册提示词、工具、消息或提供方请求。

#### KV Cache 影响

无；本包从不组装模型输入。

## 已知限制与暂缓事项

- 镜像是只读的：镜像行上没有重试、分支或反馈操作。
