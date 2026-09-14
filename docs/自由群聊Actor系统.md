# 自由群聊 Actor 系统(GroupChatRuntime)

普通群聊从「单飞回合:busy 一票拒绝 + 一次 LLM 调用生成整批台词」改造为多角色 Actor
系统:A/B/C 各自独立绑定模型(API 档案或网页站点)、独立 FIFO 收件箱与 ACK 游标、
并行生成、提交时统一排序;每个角色自行判断 speak/listen,**没有导演**。AI 剧场
(RelayDirector)完全不动,只共享恢复经验与网页 Hub。

## 1. 总体架构

```text
用户 ── send ──→ ChatSession(兼容壳/分派器)
                   │  engine = 'actors'(默认)/ 'legacy'(回退开关)
                   ↓
            GroupChatRuntime(src/groupChat/runtime.ts)
                   │
        ┌──────────┼──────────────┐
        ↓          ↓              ↓
   actorWorker  actorWorker   actorWorker      ← A/B/C 并行,单飞请求
        │          │              │
   ActorModelAdapter seam(可注入)              ← apiActor / webchatActor
        └──────────┼──────────────┘
                   ↓
   roomRouter(提交临界区:ACK 校验→降级裁定→预算→roomSeq)
                   ↓
   roomJournal(内存事实源,roomSeq 严格递增)
                   ↓
   ChatSession:onCommit → 立即落盘(chatlog)+ presenter 入队
                   ↓
   roomPresenter(按 roomSeq 串行:presentTurn → speakTracked → await ended)
```

## 2. 模块表(src/groupChat/)

| 文件 | 职责 |
|---|---|
| `types.ts` | 领域类型(RoomMessage/ActorBatch/ActorReaction/Binding/快照);绑定与档位规范定义在 configStore |
| `autonomyPolicy.ts` | 预算表(quiet 4/3/45s、natural 12/8/2min、lively 30/16/5min)、全 invocation 限流(12 次/分)、重复护栏、退避(1s→30s,连续 4 败暂停) |
| `actorSchema.ts` | 输出解析(容错 JSON)+ `validateActorReaction`(batchId/ackThrough/replyTo 任一非法 = invalid,不 ACK) |
| `roomJournal.ts` | 内存消息日志,roomSeq 分配;`bootstrap` 从 chatlog 引导历史(context-only) |
| `roomRouter.ts` | 批次连续前缀(≤12 条/4000 字/200ms 合并窗)、提交临界区(互斥串行)、epoch/停止、catchUpDigest、disabled 游标跟尾 |
| `actorWorker.ts` | 单角色状态机 idle→collecting→invoking→committing/backoff/paused;用户抢占=作废在飞重收集 |
| `actorPrompt.ts` | 输入协议(人设+纪律+用户最高指令权+未读+预算提示+输出协议);fullContext/recovery 双形态 |
| `userAuthority.ts` | 停止/转向判词(从严)、@点名>甲乙轮换的主回应解析 |
| `runtime.ts` | 唯一外部接口 sendUser/openUserTurn/cancel/reset/getSnapshot/whenQuiescent/presentationHold/dispose |
| `presenter.ts` | 呈现管线:按 roomSeq 串行 present→TTS;徽标按 causalRootId 原子领取;持有静止闸 |
| `adapters/types.ts` | ActorModelAdapter seam(react/prefersFullContext/invalidate/dispose) |
| `adapters/apiActor.ts` | API 通道:llmGateway.complete + 模型档案(profileId 缺省/'main'=主模型) |
| `adapters/webchatActor.ts` | 网页通道:四段会话键 + 两段式恢复 + 15 轮上下文卫生 |

## 3. 模型绑定(设置 → AI 模型)

- `modelProfiles`:独立 API 端点档案(label/baseUrl/model);Key 经
  `modelProfileKeys` 由 SECRET_FIELDS 改道凭据库 `llm:profileKeys`(map 型一条)。
- `groupChatActors.A/B/C`:binding = `{kind:'api', profileId?} | {kind:'web', site} | {kind:'disabled'}`
  + autonomy 档位;`engine: 'actors'|'legacy'` 回退开关。
- 迁移默认(控费用):A=主模型+natural、B=主模型+quiet、C=disabled。
- `characters.C.enabled=false` 只在运行时算 `effectiveBinding.C=disabled`,不回写配置。
- profileId 白名单 `^[a-zA-Z0-9_-]{1,48}$`,`'main'` 保留;Rust 端先校验再按对象键
  读取(**不拼 JSON Pointer**);Key 由 Rust 从凭据注入,前端不碰地址与密钥。

## 4. 一致性语义

**提交临界区**(roomRouter,互斥队列串行):
```
validateActorReaction ─失败→ invalid(不 ACK,退避重试同一批次)
停止态 ──────────────→ listen+ACK
旧 epoch ────────────→ listen+ACK + stale(网页会话排队重建)
重复文本 ────────────→ listen+ACK
speak → 链存在/open/未过期/深度/预算 → tryConsumeReplyBudget(权威)→ 失败降级 listen
通过 → 分配 roomSeq → journal → 游标=批次末尾 → onCommit(落盘+呈现入队)→ 广播唤醒
```

**不变量**:I1 roomSeq 严格递增且全员可见序一致;I2 非法 ACK 永不删队列;I3 每批
最多一条公开回复、有新消息才能再发言;I4 并发争抢预算只成功一条;I5 重启游标对齐
尾部绝不重答;I6 旧 epoch 迟到回复不上屏;I7 catch-up 用户消息原文进摘要绝不丢;
I8 cancel 后 Worker/当前 TTS/待播全停。

**静止谓词**:`无在飞请求 ∧ 收件箱无可执行批次 ∧ 无待提交回复 ∧ TTS 队列排空`。
`busy = !静止`;send 在 busy 时照常受理;voiceSession 依赖的 whenIdle/cancel 语义完整保持。

**持久化定位——「会话内可靠队列」(如实声明)**:FIFO/ACK 强一致在内存;chatlog.jsonl
只提供历史与上下文(条目带 roomSeq/epoch/causalRootId/replyTo)。重启 = 游标对齐
日志尾部,历史仅作提示词上下文,**不恢复待处理消息、不宣称崩溃一致性**。落盘失败
不影响内存提交,diag 可见,不虚称 durable。

## 5. 与设计文档的偏离决策表

| 文档条目 | 落地 | 理由 |
|---|---|---|
| §8 ActorBatchCommitted 事件持久化 | 不建独立事件存储;chatlog 即持久记录 + 游标对齐尾部 | 桌面单机场景重启丢待处理可接受(产品选择) |
| §13 回复重复「不 ACK」 | 重复按 **listen+ACK** | 避免/拒绝重复提交造成的调用死循环;重复护栏计数 |
| §13 追赶「暂停+摘要」 | 同左,但摘要由 Worker 到阈值即触发(不再被动退避空转) | |
| §7 输出协议 | batchId/ackThrough 严格回显校验 | 评审要求 ACK 校验拒删队列;prompt 明示逐字照抄 |
| 语音「句级提交」 | 改为 commit 即落盘,TTS 是下游消费者 | 文档 §8 语义;被打断的回复已入日志(群聊真实感) |

## 6. clarify 短路(队列语义)

```
用户消息入列(openUserTurn,不唤醒)
  → 工具 prepareTurn(一次)
     ├─ note/memoryRefs 附到该消息上下文 → wake()(抢占式作废在飞,重新收集)
     └─ clarify → 主回应人直接发一句(awaitUser)→ 链 status=awaiting-user
                  → 不唤醒任何 Worker,不伪造 ACK
用户补充 → 新批次 = 原问题 → clarify → 补充,角色一次读完正常 ACK(只答一次)
```

## 7. 网页会话键与恢复

`group:<roomId>:<actorId>:<bindingRevision>:<sessionGeneration>`

- 换代事件:绑定切换(指纹变)/转向(epoch)/停止时在飞作废/清空/连续 15 轮卫生重建。
- 两段式恢复:首叫失败 → 换代 + `rebuildPrompt` 全量进度重发恰一次;再失败交 Worker
  退避(批次未 ACK)。
- 旧键页面 `webchat_release_conversation` 释放——幽灵回复不可能进入新批次。

## 8. 排查表

| 症状 | 看哪里 |
|---|---|
| 某角色不回话 | 设置→AI 模型→群聊角色绑定(绑定/活跃度);群聊页群头状态点;诊断 llm_finished(groupActor) 的 actor 字段 |
| 角色持续沉默 | 预算耗尽(maySpeak=false)或全员 listen——发新消息开新链 |
| 角色刷屏 | 活跃度调低;重复护栏/限流见 autonomyPolicy;诊断 attempt/queueDepth |
| 网页角色答非所问 | 会话键 generation 是否换代(转向/停止会重建);链路诊断 webchat_stages |
| 重启后重复回答旧消息 | 不应发生(I5);若现,查 bootstrapHistory/alignCursorsToTail 调用 |
| 群聊页不刷新 | 'chatlog-bump' 跨窗事件;设置窗入口 installChatlogSync 是否安装 |
| API 档案 401 | 档案 Key 未写入(llm:profileKeys);设置页重输 Key |
| 回应期间发送被拒 | 不应发生(busy 退役);仅销毁中返回 backpressure |

## 9. 测试

- `tests/groupChatCore.test.mjs`(18):批次前缀/合并窗/ACK 校验/旧 epoch/重复/预算
  并发/awaiting-user/停止/catch-up/限流 + Runtime 集成(自由聊/抢占/停止恢复/重启/
  C 跟尾/presentationHold/dispose)。
- `tests/groupChatSession.test.mjs`(5):呈现序=TTS 序=roomSeq、打断全停、whenIdle
  等 TTS 排空、clarify 零调用、legacy 分派。
- `tests/groupActorsConfig.test.mjs`(9)+ Rust endpoint_proxy 档案测试;旧矩阵
  `tests/chatSession.test.mjs` 指向 legacyChat 继续有效。
- Tauri 实机待验:同站点三会话并行、网页角色两段式恢复、真实站点 JSON 输出合规率。
