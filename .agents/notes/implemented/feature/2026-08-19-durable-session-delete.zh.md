# Agent Note: 贯穿持久层–registry–RPC–UI 链路的会话真删

Status: implemented

[English](2026-08-19-durable-session-delete.md) | 中文

## Problem

归档（[session archive](2026-07-31-session-archive-global-set.md)）只是隐藏会话：持久日志永远留在磁盘上，产品内没有任何入口能移除它。要回收磁盘或清除一份敏感转录，只能在产品外手动删除 sessions 根目录下的目录，而手动删除会留下过期的 registry 状态——归档集合成员资格与 workspace 记账槽位——下次重启时依然可见。会话行菜单根本没有破坏性入口；最初的归档决策已把仅可视的 "Delete session" 占位改造成了非破坏性动作。

## Decision

**删除是一条一等链路：持久层删字节，registry 在日志之后删引用，一个 RPC 加一个复用的 host frame 走线，UI 在提交前确认。**

- 持久层：`SessionPersistence.delete(id)` 到达各后端的 `deleteStored`。JSONL 后端移除每个 project scope 下的会话目录（recursive 且 force——幂等，目录内会话私有的工件随之而去）；SQLite 后端删除 `sessions` 行，`events` 外键级联删除。
- Registry（`workspaceRegistry.deleteSession`，走 `enqueueOperation`）：活动会话以 `WorkspaceLiveSessionError` 拒绝；持久日志先删，因此中途失败留下的是仍可经持久层恢复的日志，而不是一个已无日志却仍被列出的会话。随后清理引用——header 索引、路径缓存、每个 workspace 实体的记账槽位、归档集合成员资格——再发出 `workspace/session-deleted`。未知 id 解析成功而非报错：过期引用在同一次调用中清理（删除在 registry API 上幂等）。
- 活动会话的所有权边界：`AgentHandle.dispose()` 是能力，而 api 网关（`ensureSession`）原本在创建后即丢弃 handle——产品中不存在任何拆毁活动会话的路径。第一种尝试只保存网关自己的 handle 并只销毁那些，其他创建者（voice-edge 桥、subagent 父会话）依旧删不掉。落地规则：AgentRegistry 是 factory provider 的宿主，因此它持有 `AgentHandle` 语义已授予 provider 的同一结构性销毁权（"provider unload stops and drains every live handle it made"）；`AgentRegistry.dispose(id)` 正是暴露这一权利。registry 登记 `create`/`resume` 铸造的每个 handle，`workspace.deleteSession` 经它结构性销毁任何活动 agent——无论由哪个组件铸造——而普通消费方的生命周期仍走其主人保留的 handle。只有无 factory 铸造 handle 的裸活动会话应答 `session-live`。
- Wire：`workspace.deleteSession({sessionId}) → {deleted: true}`，`session-live` 为业务拒绝码。registry 事件复用既有的 `host/session-removed` 帧——持久删除不是活动会话的销毁，但客户端效果（该行离开列表与会话视图）完全相同，因此广播这一段不需要新帧类型。
- 客户端运行时：workspaces manager 增加该调用；sessions manager 既有的 `host/session-removed` 折叠让本标签页与其他标签页一并移除该行，投影层以与归档相同的单一规则把被删除的当前 selection 清空为 New Session 视图状态。
- UI：会话行菜单新增 danger 样式的删除项；确认对话框声明不可恢复、pending 期间阻止重复提交、失败内联展示。

## Alternatives considered

**归档加保留期清扫器。** 否决：隐藏但保留回答的是策略问题；真实诉求是字节立刻消失、由用户主动发起。

**软删（墓碑标记加稍后清除）。** 否决：不存在撤销需求值得为墓碑的复杂度买单，而且半删的行恰恰会招致这条链路要消灭的过期引用混乱。

**Registry 先行顺序（先删引用，再删日志）。** 否决：中途失败会留下日志已消失却仍被列出的会话；日志先行把失败安全落点从"列出的幽灵"换成"可恢复的孤儿"。

**专用 `host/session-deleted` 帧。** 否决：持久删除与活动会话销毁的客户端效果是同一个行移除；每个客户端可见事实一个帧，客户端折叠保持单一来源。

## Consequences

删除不可恢复，每一层都如实声明：确认框点名这一点，未知 id 解析成功而非报错，因此部分手动删除后重试即修复 registry。删除当前打开的会话——无论 Web 还是 voice-edge——都是一次点击而非两步操作：结构性销毁在同一次调用内完成；只有无 factory 铸造 handle 的裸活动会话以 `session-live` 内联错误到达对话框。删除与归档及所有 registry 写共享 `enqueueOperation`，两个操作不会交错。日志先行意味着失败的删除让会话完好无损且可重试。Registry 测试固定顺序（日志消失时记账仍列出该会话）、中途失败、活动拒绝、重启后的过期归档清理；agent registry 测试固定 dispose 的一次性语义；apiproxy 测试固定网关自有与外来铸造（voice-edge 形态）活动会话的先销毁后删除流程、裸会话拒绝与帧；voice-edge spec 固定桥接侧——其 `session/disposed` 监听器丢弃绑定的会话，下一次 bind 重建全新会话而非持有过期 agent 或收养已删日志；UI 测试固定确认流程与重复提交阻断。
