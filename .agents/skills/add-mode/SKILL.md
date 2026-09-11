---
name: add-mode
description: 给这个虚拟角色应用新增一个与"日常/相声"平级的演出模式(工具栏分段按钮可点播的对话剧本风格)。Use whenever the user says 加个XX模式 / 来个新玩法 / 新增点播模式 / 想让它讲XX / 换个对话风格, or mentions DialogMode、MODES 注册表、新剧本形式 — even casually, e.g. "加个辩论模式、正反方互怼那种".
---

# 新增演出模式

一个"模式" = 一个数据文件 + 注册表里一项。分段按钮、历史徽标、LLM 编剧指令、话题池、预生成、回放节奏、命令面板点播、自然语言路由(靠 `triggers` 字段)全部自动感知;真正要看一眼的只有 relationships 兼容性。本 skill 带你走完全程,最后有验证清单。

## 第 0 步:先读契约

1. `src/performer/modes/index.ts` — `DialogMode` 接口 + `MODES` 注册表。文件头注释就是官方指引:"新增模式 = 新建 ts 文件 + MODES 加一项,其余自动感知"。
2. `src/performer/modes/daily.ts` — 24 行标准模板;`crosstalk.ts` 是结构化(相声格式)范例。

## 第 1 步:和用户对齐四要素

用户没说清就先提案再动手:
- **id**:英文 kebab-case(如 `debate`)。落盘到历史的 mode 字段,不能与现有 id 重复。
- **label**:分段按钮上的中文名(如 "辩论")。
- **风格定位**:写进 `prompt` 字段的编剧指令,是模式的灵魂——说清角色关系、话语结构、包袱节奏。对照 daily.ts(自然闲聊)和 crosstalk.ts(垫话→正活→收底)找感觉。
- **节奏 `gap`**:台词间奏毫秒数。快嘴互怼 200~300,自然闲聊 400 左右,慢节奏 500+。

## 第 2 步:新建 `src/performer/modes/<id>.ts`

仿 daily.ts 写。字段逐个说:

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✓ | 与第 1 步一致 |
| `label` | ✓ | 中文名 |
| `accent` | ✓ | 徽标强调色,hex 字符串,别和现有模式雷同 |
| `gap` | ✓ | 间奏 ms |
| `script` | ✓ | LLM 失败时的兜底剧本,`DialogLine[]`,6~8 句为宜 |
| `prompt` | ✓ | 编剧指令,拼进 system prompt 尾部 |
| `topics` | 可选 | 专属话题池;缺省用 `src/engine/topicSeeds.ts` 全局池 |
| `interestTopicChance` | 可选 | 抽"使用者兴趣"作主题的概率。闲聊类高些(日常 0.35),结构化模式低些(相声 0.12) |
| `triggers` | 推荐 | 自然语言点播触发词,如 `['辩论', '抬杠']`——写了它,"来一段XX"才能命中;缺省只能从分段按钮进 |

兜底剧本的 `DialogLine` 写法(字段清洗在 `src/performer/dialogSchema.ts`,非法值会被自动归一,但别依赖兜底):

```ts
{ speaker: 'A', text: '我最近发现一条发财的路子。', action: 'talk' },
{ speaker: 'B', text: '好家伙,倒贴三百多。', action: 'surprise', listenerAction: 'sad', pauseAfter: 1200 },
```

- `speaker`:`'A' | 'B' | 'C'`(C 是常驻第三角色,双人模式别用)。
- `action` / `listenerAction` / `reactions` 取值必须来自 `dialogSchema.ts` 的 `VALID_ACTIONS`(13 个:idle talk happy laugh shy sleepy wave thinking angry sad surprise shake jump)。
- `pauseBefore` / `pauseAfter`:包袱前蓄势 300~600,响底后留白 900~1500。
- `delivery`:`'deadpan' | 'excited' | 'slow'`,影响 TTS 语速,可选。

## 第 3 步:注册

`src/performer/modes/index.ts` 的 `MODES` 对象加一项(import + 键)。`Mode` 类型、`modeList` UI 顺序、`modeOf` 查找全部自动派生,不要手写类型。

## 第 4 步:仅剩的检查点

注册表 + `triggers` 已经覆盖一切常规接线,**不要**再改 `commands.ts` 的路由正则或任何 `'daily' | 'crosstalk'` 字面量联合——那些已全部数据驱动(命令面板的点播命令由 `App.tsx` 从 `allModes()` 自动生成,自然语言路由按各模式 `triggers` 动态拼正则)。

1. `src/performer/modes/relationships.ts` — `pickRelationship` 按标志过滤兼容局势;新模式默认吃全池即可,若有局势与新模设定冲突,给局势加过滤标志。
2. 万能兜底:`grep -rn "crosstalk" src/`,逐条确认新 id 是否需要类似处理(如 `ControlBar` 对 live 的按钮 title 特判、`usePerformanceDirector` 对 live 的 play 特判——只有"live 式"新模式才需要,见边界)。

## 第 5 步:测试与验证

- 仿 `tests/dialogueDirector.test.mjs` 的脚手架(vite `createServer({ server: { middlewareMode: true } })` + `ssrLoadModule` 直接加载 TS 源码,node:test + `assert/strict`,依赖注入、不碰网络磁盘)补一个 `tests/<id>Mode.test.mjs`:断言 MODES 含新 id、`buildMessages` 注入了新 prompt。
- 命令:`pnpm test`、`pnpm lint`、`pnpm build`(build 内含 tsc 类型检查,三绿才算完)。
- 手验(`pnpm tauri dev`):分段按钮出现 → ▶ 生成可播 → 对它说"来一段XX"能路由 → 断网/配错 key 验证兜底剧本可播 → 历史面板徽标颜色正确。

## 边界与仓库约束

- **live 模式不是纯注册表项**:它接了 `src/live/` 弹幕源,`usePerformanceDirector` 的 `play()` 对它特判。想做"直播式"新模式超出本 skill,单独讨论。
- 注册表派生的分段按钮不用管热区;若为新模式新画了可点 UI,必须注册热区(README:"任何可点元素必须注册热区",见 `src/input/pointerManager`)。
- 轻量的"风格/剧本"型定制也可以不写代码,直接用应用内的模式工坊(设置 → 模式工坊,AI 生成自定义模式);本 skill 适用于要进代码库、随版本分发的正式模式。
