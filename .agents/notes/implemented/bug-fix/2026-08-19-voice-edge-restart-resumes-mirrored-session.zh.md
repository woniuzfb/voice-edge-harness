# Agent Note: Voice Edge 重启后 resume 镜像会话

Status: implemented

[English](2026-08-19-voice-edge-restart-resumes-mirrored-session.md) | 中文

## 问题

桥接的 boot/full-key 别名表只存在于内存。宿主重启后表为空，后续的 `/session/bind` 查找未命中，落进 `agents.create`，用 claimed key 派生的会话 id 新建——带来两个后果。其一，turn 1 以 `sha256(boot_key)` 绑定、turn 2+ claim `full_key` 的对话，跨重启分裂成两个会话。其二更糟：磁盘上已有 `sha256(full_key)` 的对话，create 会铸造同 id 的 seq-0 新会话；内存里的每个请求都成功，但 turn 收尾的 flush 派发 `session/flush` 时持久化后端拒绝在已提交的日志上物化——整轮镜像以 500 失败，事件从未落盘。`voice_edge.py` 每次 bind 都带上全部三个 key（[探测点](../../../../packages/host/voice-edge/src/index.ts)），恢复绑定所需的信息本就在线上，只是 harness 这一侧把它忘了。

## 决策

查找未命中时，`createConversation` 探测持久化存储（`sessionPersistence.list()`）：先按 claimed key 的会话 id、再按 boot key 的，命中即通过 `agents.resume`（挂载与 create 路径相同的 preset setup）resume，而不是新建同 id 新会话。于是 turn 2+ 的 bind 收养 turn 1 以 boot key 绑定的会话；续聊直接 resume 自己的会话。任何候选 id 上已有 live agent 时，先于一切 resume 直接重新挂载该 agent 作为绑定：Web 客户端可能在桥接表为空期间（宿主重启加浏览器标签页保持打开）经 apiproxy resume 镜像会话，而在 live 会话之下再 resume 会撞上持久化协调器的 `cannot prepare session while it is live` 拒绝——本功能首发版本正是在那里 503。探测顺序优先强身份，旧行为已分裂的会话继续留在 full-key 会话上（分裂是历史损伤，但从此不再丢轮）。boot 探测刻意保持与内存别名相同的 first-user-line 碰撞语义：重启前的别名查找会把共享同一首句的两个对话合并，收养也同样合并——没有引入新的风险类别。未组合持久化后端时无从探测，每次绑定都全新创建，行为不变。

## 备选方案

**持久化别名表（如 sidecar 文件或 harness 侧 key 映射）。** 否决：它重复了持久会话日志已承载的信息（`voice-edge/sync` 记录 `bootKey`/`fullKey`），还多出一个要与逐出、teardown 保持一致的产物。

**未命中时扫描会话日志找记录的 key。** 否决：`persistence.list()` 加确定性的 `sha256(key)` 派生能回答同一个问题，无需读事件体，保持 O(headers)，且对 sync 事件早于任何 key 记录的会话同样有效。

**让 `voice_edge.py` 显式重报绑定。** 否决：它每次 bind 已带上它知道的全部 key；把 harness 侧的重启恢复责任推给客户端，越过了桥接的 HTTP 契约却毫无收益。

## 后果

一个对话跨重启保持在同一个会话上，且已存在的持久会话不会再被同 id 重建，后端的物化拒绝路径不可能再丢掉一整轮镜像。`agents.resume` 通过与 create 相同的 setup 回调重建 preset 组合，收养的会话保留其工具。已知残留：收养把对话永久绑定到 boot 派生的会话 id 上（之后路由由别名承担），且历史分裂的对话不会被追溯合并。
