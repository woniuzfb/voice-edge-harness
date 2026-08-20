# Agent Note: voice-edge 将 Continue 的 generateTitle 轮折叠为 session/title

Status: implemented

[English](2026-08-19-voice-edge-folds-continue-generate-title.md) | 中文

## 问题

镜像会话显示上有两个缺陷。其一，每个 voice-edge 会话在 Web 会话树里都显示 `deepseek-harness`：客户端对无标题会话的显示回退是 cwd basename，它命名的是 Harness 检出目录而非对话界面，而镜像会话永远挣不到自己的标题（标题服务从 `user/message` 事件派生，镜像从不写该事件）。其二，Continue 的 generateTitle 请求作为普通新用户轮走同一绑定的对话——固定指令后内联对话内容——于是桥接把指令镜像成用户气泡、把模型的标题回复镜像成助手气泡：标题噪音成了对话内容。

## 决策

两者都收进桥接，`voice_edge.py` 不动。每个对话在创建时获得占位 `session/title` `voice-edge`（source `fallback`），收养的无标题旧会话在 resume 时补上。generate-title 轮通过镜像的用户文本识别——`Given the following` 开头且内含 `please reply with a title`——并折叠而非镜像：该轮的 `voice-edge/sync` 与 `voice-edge/model-event` 不追加任何事件（ack 协议不变，sequence 照常推进），`voice-edge/finish` 时把最后一个非空 step 文本归一化（`normalizeSessionTitle`，200 字节预算）后以 source `{ kind: 'provider', provider: 'voice-edge' }` 追加为 `session/title`。

生成的标题只替换占位符：一旦真实标题成立——早先的生成，或显式的用户改名（会 pin）——检测被整体跳过，后续 generateTitle 轮按普通内容镜像。普通 sync 会取代未完成的 title 轮，中止的生成不会吞掉下一个真实轮。

## 备选方案

**在 UI 投影里过滤 title 轮。** 否决：事件仍会是持久日志内容——会话回放、导出和每个未来消费者都会继续把指令与回复当作对话轮，且"model-visible ⟺ logged"会携带不该渲染的气泡。

**让 voice_edge.py 跳过镜像 title 请求。** 否决：客户端拥有镜像，但桥接拥有会话界面（占位标题、改名保护）；把一个特性拆到线上协议与插件两侧，就要为指令文本已经说明的事引入新的"这轮特殊"事件类型。

**复用标题服务的 `rename()`。** 否决：`rename` 写 `user` source，会 pin——模型的回复不是用户的决定，pin 今天挡不住什么，但会向每个未来标题消费者误述出处。

## 后果

voice-edge 对 `@deepseek-ai/dsh-session-title` 产生运行时依赖（normalize + provider id，均为纯函数）。占位标题意味着镜像会话永不为"无标题"，cwd basename 回退不再适用于它。`bind` 在镜像意义上仍是 content-free：新会话携带的唯一事件是占位标题。检测基于镜像用户文本的前缀匹配：用户真的写出以 `Given the following` 开头且含 `please reply with a title` 的 prompt 时该轮会被折叠——这是识别无标记字段的固定客户端指令的代价。

由 `voice-edge.spec.ts` 覆盖：bind 时的占位标题、折叠为标题（sync/model-event 计数不变、标题以 provider source 落地）、用户改名 pin 住生成、早先生成的标题在第二次 generateTitle 轮后保持。
