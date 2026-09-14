# 精选演出话题库改造——完成记录

- 施工窗口:2026-09-14 07:56 → 09:00 暂停 → 14:08 恢复 → 收尾完成
- **最终状态:全部里程碑完成,`pnpm test` 544/544 ✅ / `pnpm lint` 0 warning ✅ / `pnpm build` ✅**

## 交付内容

### M1 结构化人设来源 + castHash

- `configStore.ts`:`personaSource {a,b,c}` 字段 + `sanitizePersonaSource` 清洗 + 旧配置迁移三规则(空文本→default;识别为内置默认全文→default;其他非空→custom)
- `PersonaSettings.tsx`:编辑文本→`custom`,清空即回 `default`;「还原默认人设」改为存空文本 + source='default'(不再把默认全文写进配置)
- `persona.ts`(`src/engine/persona.ts`):`sources` 模块态;`usesDefaultPersona(id)` 只读结构化来源;`setPersonaOverride` 扩签名可带来源;`castHash()` FNV-1a 内容哈希(人设+名字+性别,跨重启稳定);`actorWorldOf(config)`
- 采纳点同步:`bridgeServer.ts`(persona+personaSource 差分)、`App.tsx` 启动加载
- 缓存兼容:`PlanCompatibility.castHash`;`prefetchStore.compatible()` 严格相等;`buildPrefetchCheck` 带当前值;`PrefetchCheck.manualFingerprint` → `requestedFingerprint`
- `PLANNER_VERSION` 1→2(旧预生成全部失效);删除无人消费的 `TOPIC_PLANNER_VERSION`
- `TopicCard` 仅增三个有行为的可选字段:`angles` / `roles{initiator,challenger}` / `applicability.actors`;`store.ts` 透传+钳制

### M2 TopicCatalog 深模块

- 新 `catalogContent.ts`(纯数据):核心池 85 条 + `TOPIC_PACKS` 默认包 20 条 + 分类标签/角度池/hook 模板 + 换皮允许列表
- `catalog.ts`:`createTopicCatalog({ getReservoir, getHistoryPieces })` → `query(ctx)→{items,facets}` / `resolve(id,ctx)` / `candidates(ctx)`;facets 与 items 同源;角色 applicability + 模式 + 雷区 + 近期指纹门控;seed 化确定性排序;hook 确定性(消灭模块加载期 `Math.random`);angles 卡自身优先;sensitive 不进自动池;character-history 仅来自真实故事
- `index.ts` 收口(不再导出 `CURATED_CARDS`,导出 `topicCatalog` 单例);`storyStore.peekStory()` 同步读
- `director.ts`:pin 走 `catalog.resolve`;dynamic 精选源走 `catalog.candidates`(自动演出与 UI 同源);`interestTopicChance` 由开关改为真概率(命中即从兴趣卡直接择优)
- `promptBuilder.renderTopicPlan`:渲染「角色动力学」与「敏感约束」两行

### M3 面板重做

- `App.tsx`:命令入口「设置聊天主题」→「选择演出话题」;面板头→「当前演出话题」;分类按钮由 facets 动态生成(带计数、空分类隐藏);推荐排除最近 20 集、模式/角色优先、seed 稳定、「换一批」、点播后刷新;卡片双行(标题 + hook 预告);搜索多字段;点击传 `pinCardId`
- `usePerformanceDirector.ts`:`PlayRequest.pinCardId`;开播前先 `resolve` 原卡,指纹作为 `requestedFingerprint` 进缓存检查(点 A 卡不再命中 B 卡预生成)
- `App.css`:`.topic-item-title` / `.topic-item-hook` 双行样式

### M4 内容

- 默认世界包 22 条(全部手写 hook):A×B 交叉 11、A 独立 5、B 独立 4、C 2(逐卡 `applicability` 门控,包仅分组)
- emotion 7 条 + imagination 6 条通用骨架(带 roles,不绑职业)
- 缺陷修复:删除旅行换皮对;4 条错分类归位(种草拔草→consumption、一键破防→emotion、图书卡/宠物看病→life);健康/金钱/相亲/亲戚拷问补标 `personal`

## 验收证据

| 验收项 | 结果 |
|---|---|
| 可见分类均非空、无空列表 | ✅ facets 动态生成,空分类不出现(character-history 无往事时自动隐藏) |
| 无换皮题目 | ✅ 换皮审计用例:titleSimilarity>0.6 全库两两检查,不在允许列表即失败 |
| 点卡后 ID/标题/hook 与展示一致 | ✅ `resolve` 返回原卡;resolve 用例断言 hook 同源 |
| 同种子同推荐/同切口 | ✅ query 同 seed 同结果 + 前缀稳定用例 |
| 最近 20 集不重复 | ✅ recent 指纹硬去重用例 |
| ≥20% 固定题依赖甲/乙/丙人设 | ✅ 包 22 条 / 总 107 条 ≈ 20.6%,包内 100% 带 applicability;核心池经审计确认零职业绑定 |
| 30 连抽单分类 ≤30% | ✅ 8 组种子 × 30 连抽审计:最大单分类占比 0.17~0.20,均值 0.196 |
| 敏感题不映射观众 | ✅ promptBuilder 渲染断言 + candidates 排除 sensitive 用例 |
| 旧预生成安全失效 | ✅ PLANNER_VERSION=2 + castHash 不符即不消费用例 |

## 测试新增/更新

- `topicCatalog.test.mjs`:精选池 85 条与分布、包规模与构成、门控矩阵(双默认/仅 B 自定义/双自定义)、query 稳定性与 facets 同源、resolve 三级查找与门控回落、candidates 排除 sensitive、换皮审计、personaSource 迁移三规则、castHash 稳定性与敏感性
- `topicDirector.test.mjs`:最近 20 集去重(环境卡计入窗口)、评分骨架、分类疲劳单调性、30 连抽分布审计、兴趣概率语义(0.3→daily 命中 / crosstalk 不命中;0.9→不命中;无兴趣词→不命中)
- `prefetchChoice.test.mjs`:兼容令牌增 castHash 项、点卡不误命中他卡预生成
- `promptBuilder.test.mjs`:roles 与 sensitivity 渲染断言
- `prefetchChoice` / `nonComedyCard`:补 castHash 与 `requestedFingerprint` 字段改名

## 本期明确未做(下期候选)

- 核心池 ~90 条全面重写(本期只做去重与错分类修复)
- persona-derived 运行时衍生素材 LLM 链路(人设 revision 触发生成 + 换代清除)
- seasonal/freshness 时效内容
- fitArchetypes 原型评分(需先有"角色拥有哪些原型"的结构化事实源)
- `ALLOWED_SIMILAR_PAIRS` 目前为空;新增表面相似但立场不同的系列题时在此登记
