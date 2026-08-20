# Agent Note：Voice Edge 镜像 append 由客户端交付

Status: implemented

[English](2026-08-19-voice-edge-client-owned-mirror-appends.md) | 中文

## Problem

桥接的第一版 API 把"记录"耦合进了"传输"。`/session/sync` 接收 `messages` 投影并自行 append `voice-edge/sync` 事件，用一套仅次于 relay 的简化第二解析器从原始客户端历史里重新提取用户文本。只有第一套解析器认识的客户端消息形态（Continue 的 part 数组）产出了文本为空的 sync 事件——Web 镜像里出现空的 user 气泡——而实际的模型请求（由 relay 清洗后的最终 prompt 组装）完全正常。`/model/event` 与 `/turn/finish` 是两个独立的 append 端点，`/tool/execute` 又记录工具对，日志的作者身份散在四条路由上，没有任何一处声明谁拥有哪类事件。

## Decision

voice_edge.py 拥有信息流，插件被动。`/session/bind` 只绑定 key、create/resume agent、返回工具 schema——不记录任何东西。唯一的 `/event` 端点 append 客户端显式交付的任何事件：`voice-edge/sync`（其 `messages` 携带用户的新鲜 turn 正文——`PreparedTurn.user_text`，提交 prompt 经 relay 提取的 body；tool-result 续轮与纯附件轮为空，不镜像 user 消息）、`voice-edge/model-event`、`voice-edge/finish`（同时派发持久化 flush）。`/tool/execute` 不变：执行属于 harness，因此它继续在事实所在处记录 `voice-edge/tool-call`/`voice-edge/tool-result` 对。每个事件类恰好一个作者——流内容来自客户端，执行结果来自执行者——harness 侧对客户端消息的解析彻底消失。事件类型与负载不变，ui-voice-edge、blankness、重启收养都不受影响。镜像文本逐字存储：此前所有长度上限（sync 每条消息 4,000 字符、事件文本 16,000 字符、50 条消息投影限界、客户端侧 prompt 截断）全部删除——HTTP wire 层的 `config.maxBodyBytes` 是唯一尺寸边界，日志呈现的不会少于到达的内容。

## 备选方案

**修第二解析器使其对齐 relay。** 否决：对同一字节的两个解析器天然漂移；每种新客户端信封都会先变成一个镜像 bug，再被人补齐。

**保留 sync 不动，另加专用 `/user/message` 端点。** 否决：误导性的 `messages` 投影仍在线上，还多出第四条 append 路由；一个带 `type` 判别 tag 的 `/event` 在单一位置声明契约。

**让客户端也交付工具事件，使所有 append 都归客户端。** 否决：执行者已持有调用参数、结果、耗时与错误状态；让客户端复述它们，为 harness 真正拥有的唯一事件类造出第二事实源。

## 后果

镜像不可能再偏离模型实际收到的内容：user 气泡是 relay 提取的 turn 正文——与提交 prompt 携带的同一第一提取器输出——去除传输框架。镜像的 assistant step 改经共享的 assistant-Markdown 原语渲染（字面文本原语违反了该原语自身声明的分工），渲染器的图片门放行格式良好的行内 `data:image/*;base64` 位图——模型生成的图片以 base64 markdown 到达——而 SVG（可携带脚本的文档）与被截断的载荷（流在图片中间断开留下不完整的 base64 组）回落到 alt 文本。用户自己的内联图经 m365 附件通道上行（为视觉模型上传），提取的 turn 正文因此丢失它们；镜像仅在新轮把它们重建为 markdown data URI——门控是 `PreparedTurn.fresh_user_turn`，因为附件收集在每个 tool-result 续轮都会重读同一条最新用户消息，不加门控就会每一轮重复镜像旧图——user 气泡与 assistant 行出于同一原因渲染 Markdown。框架豁免是刻意的：harness 工具目录必然以 `<tool_use_instructions>` prompt 文本进入每轮模型请求（浏览器模型没有原生 function calling，指令块就是工具信道，voice_edge.py 从 bind 目录执行注入），但它是每轮样板，可从 harness 自己的目录重建；把它记进每个 user 气泡只会把用户提问埋进工具 XML 墙——可读镜像记录的是对话内容，不是传输。bind 幂等且无内容，重复 bind 不会复制或损坏一轮。客户端的失败姿态（fail-open，每个镜像 tap 失败即记日志丢弃）成为唯一可能丢日志行的姿态——镜像故障永不触碰请求路径，harness 也永不静默丢弃已交付的内容。已知残留：bind 成功但在 user-message tap 之前崩溃的 turn，会留下没有 `voice-edge/sync` 的会话，保持 `blank: true`——与从未开始过的对话可见性相同。
