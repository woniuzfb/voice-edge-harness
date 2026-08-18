# Agent Note：voice-edge 会话 Agent 加入 agent preset

Status: implemented

[English](2026-08-18-voice-edge-joins-agent-preset.md) | 中文

## Problem

voice-edge 桥接绑定的每个会话都通过 `ctx.agents.create` 创建 Harness agent，且不加入任何 preset。这个 agent 能否看到工具取决于部署的哪一层持有工具：无 roster 的组合（base-only profile）把模型可见的工具行放在 host 层，任何 agent 都能看到；而 preset 持有的组合——web app 是已发布的这类——禁用了那些工具行，改为按会话通过 preset 常驻挂载暴露工具。在 presets 体系之外创建的 voice-edge agent 什么也没加入，于是 `dsh web` 上 `session/sync` 返回 `tools: []`，`tool/execute` 无工具可执行。桥接的镜像一半正常，工具一半静默缺失——对调用方无法区分"空 roster"和"组装错误"的桥来说，这是最坏的形态。

## Decision

`createConversation` 以 [api-proxy](../../../../packages/host/apiproxy/src/api-proxy.ts) 为 web 会话组装 agent 的同一方式组装自己的 agent：`ctx.get('agentPresets')` 返回 roster 时，在创建**之前**解析配置的 preset（config `preset`，未设置时用 roster 默认），使 session header 能把 `meta.agentPreset` 快照进去；factory 的 `setup` 回调在未发布的 agent scope 上挂载它，于是损坏的 preset 让整个创建回滚为既有的 503 `agent_unavailable` 应答，而不是发布一个组装了一半的 agent。没有该服务时什么也不变——无 roster 的部署本就通过 host 层展示工具，这是 presets 出现之前的行为，在那里仍然正确。

与 api-proxy 的一个刻意差异：voice-edge 在重绑定时从不从日志重新解析 preset。会话的 agent 已存在时按原样采纳，不存在时按当前配置重建——与桥既有的 `cwd` 立场（请求/配置优先于持久化状态）一致，而非网关的会话连续性立场。voice-edge 会话是镜像，其历史不是在某个 preset 的工具集下产出的，连续性买不到任何东西。

修这个问题时暴露了一个潜伏的注册缺口：`packages/host/voice-edge` 缺席 `tsconfig.host.json` 的 references，这个包的源码从未进入 host aggregate 的文件列表——增量 buildinfo 掩盖了它，生成的 persistence catalog 和 `KNOWN_SESSION_EVENT_TYPES` 也静默漏掉了所有 `voice-edge/*` 事件。补上 reference 使生成的 catalog 在同一变更里补齐。

## Alternatives considered

**把加入 preset 留给部署，用 base-only profile 解决。** 可行——专用 `voice` profile 就是例子——但这让 web 组合永远低人一等，还让一个桥为了执行工具分裂成两个进程。拒绝：presets seam 的存在意义就是让 agent 创建者加入组装，voice-edge 是 agent 创建者。

**创建后在 `setup` 之外挂载 preset。** 被 presets 契约拒绝：factory 未发布的 `setup(agentCtx)` 是唯一受支持的调用点，只有在那里被拒绝的组装才会回滚创建。发布后挂载会留下一个能力组装了一半的已发布会话。

**把 `preset` 默认成固定 id 而非 roster 默认。** 拒绝：在插件里硬编码 roster 名字会在每个发布不同 preset 的部署上失败；`undefined → roster 默认` 与网关用同一条解析规则，默认值只有一个来源。

## Consequences

- 在 `dsh web` 上，`session/sync` 现在返回 preset 的工具目录，`tool/execute` 为语音会话执行真实工具；web profile 的 patch 不需要 `preset` 值，除非想用非默认 preset。
- 无 roster 部署的行为逐字节不变；没有 `agentPresets` 服务时新配置字段不起作用。
- 有 roster 组装的 voice-edge 会话 header 现在记录 `agentPreset`，preset 感知的工具（侧栏、`resolveSessionPreset` 的读者）能读懂这些会话。
- persistence catalog、`KNOWN_SESSION_EVENT_TYPES` 和 host 包 README 现在列出 voice-edge 的事件与包行；重新生成它们属于本变更，不是后续工作。
- `dsh-voice-edge` 新增 `dsh-agent-presets` peer 依赖（type-only 边）；profile 安装不受影响，因为 heal 过的 `~/.dsh/profiles/node_modules` 闭包已链接它。
