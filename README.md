# virtual-character · 桌面双人情景剧角色

Windows 桌面虚拟角色(桌宠)应用:两个 Q 版角色(甲·便利店店员 / 乙·程序员)常驻桌面,
通过全屏透明穿透覆盖层与你的日常操作互不干扰。点 ▶ 就生成一集相声/闲聊,
带 LLM 编剧、TTS 语音、行为偏好学习与长期记忆,还能直接 @角色聊天。

技术栈:**Tauri 2 + React 19 + TypeScript + Vite**,Rust 侧负责窗口穿透、光标轮询与 WASAPI 声音捕获。

## 功能一览

- **点播演出**:日常/相声等模式(模式注册表化,新增内置模式零改动),LLM 生成 JSON 台词脚本,
  解析失败自动降级内置剧本;预生成下一轮实现"秒开",话题池随机 + 使用者兴趣介入 + 偏好加权。
  **模式工坊**(设置 → 模式工坊):用自然语言让 AI 生成自定义模式(与日常/相声平级),
  存本机 JSON、即时生效——模式即纯数据,分段按钮/历史徽标/"来一段XX"点播自动感知;
  兜底剧本/触发词/节奏可改,上限 20 个。需要弹幕源等代码能力的模式(如直播)仍走源码。
- **聊天通道**:点聊天按钮直接对角色说话,`@甲`/`@乙` 指定谁回,轮换应答;
  回复带明显情绪时角色立绘表情联动(情绪标签协议,面板单聊也做表情反应不弹气泡不朗读),
  并沉淀为心情余波(连被逗乐几句,待机会挂着笑意);说话内容后台提取"关于你的长期事实"进入记忆库。
- **工具循环**:命令面板(工具按钮)聚合翻译/截图翻译/提取文字/添加提醒/主题/隐藏角色/点播,
  支持搜索与整句指令("明天下午三点提醒我交报告",关键词路由 + LLM 兜底,时间先确认再入库);
  任务进度/结果走右下浮层卡,角色气泡不掺和正文。翻译面板支持自然/直译/润色、复制、朗读。
  提取文字走 AI 视觉模型优先(默认智谱 glm-4.6v-flash,免费,设置里单独填 key)、
  失败/未配置自动回退本地 Windows OCR。
- **主动行为调度**:单一调度器统管问候/自发闲聊/久坐提醒/备忘到点/空闲重放,
  优先级 + 小时配额(主动程度:安静/平衡/热闹)+ 勿扰一键全静(提醒卡片照弹);
  主动行为被连续掐断 3 次自动降频,用户一互动即清零。
- **主播模式**:与日常/相声平级的演出模式,直播弹幕互动——弹幕源走统一 Provider 接口
  (src/live,B站真实实现+抖音桩),过滤/限流管线(去重/雷区/队列上限/每分钟AI调用上限)
  攒批喂给 AI 挑一条回,甲乙都能被点名,气泡+TTS(stream 通道)+表情即时呈现;
  连接状态走任务卡,断线自动重连。设置里填B站直播间号,命令"开播/下播"或主播段按钮启动。
  Cookie 选填(SESSDATA 或完整串,建议小号):带登录态连接才拿得到观众真实用户名与舰长等级,
  不填功能照常但名字是"某***"打码样式;设置里可"B站扫码登录"免手贴(passport 二维码接口,
  手机App扫码确认后自动回填,过期自动刷新)。
- **记忆系统**:手填画像(称呼/身份/喜好/雷区)+ 机器自动提取的事实(pinned 置顶防遗忘),
  注入所有对话 prompt;行为信号(戳/收藏/重放)反馈到话题权重。
- **世界感知与桌面操作**:`src/world` 世界模型层收口全部传感器(前台应用/窗口标题/键鼠空闲/
  电量/媒体在播/CPU/内存/桌面文件数),归一+差分事件+显著性渲染(冷却账本+预算上限),
  角色注记只吃"渲染过的事实"——演出与聊天共享同一份情境;按需工具:截屏/识字/看桌面/读剪贴板
  (pull 制,默认关);确定性操作:打开网址/文件、启动应用、媒体控制、音量/静音、窗口管理、
  系统通知——全部 external 风险级,执行前弹角色风格确认卡(可"记住允许"),敏感感知在
  设置 → 工具与隐私里逐项开关,默认关的不采集。
- **语音**:硅基流动 CosyVoice2 合成,甲乙各自音色,两级缓存(内存 blob → 磁盘 base64)逐句预合成;
  支持上传参考音频或直接录制任意应用/系统声音来**克隆音色**。
- **活人感**:待机小动作、倾听倾斜、惊讶脉冲、连戳分级(害羞/生气)、LLM 即兴吐槽、
  时间感知(时段氛围 + 凌晨免打扰)、空闲自动重放历史、自发短聊天。
- **桌面集成**:点击默认不抢焦点(看视频不被打断),角色可拖动/滚轮缩放,工具栏可拖动/收起。

## 架构速览

```
src/
  engine/     LLM 与语音:llmClient(厂商兼容/错误分类,走 llmGateway 通道)、llmGateway(通用请求网关)、
              promptBuilder(人设+画像+协议)、tts(CosyVoice2+克隆+缓存+通道仲裁)、
              dialogPrefetch+topicSeeds(预生成/话题池)、timeAware
  world/      世界模型:types(WorldState/事件)、normalizer(归一+防注入清洗)、render(冷却+预算注记)、
              bus(差分事件)、engine(采样循环,全 DI)、index(单例入口 startWorld/worldNote)
  performer/  演出层:player(台词队列,LLM/硬编码剧本同一条路)、modes(模式注册表)
  runtime/    运行时地基:runtimeMode(统一状态机+capabilities)、proactiveScheduler(主动行为
              调度:优先级/配额/降频)、utilityTasks(工具任务状态)、liveDanmaku(主播模式管线:
              弹幕过滤/去重/限流→AI决策→单句回复)
  features/   commands(命令注册表+整句路由+中文时间解析)
  live/       直播弹幕源抽象:types(DanmakuMessage/Provider 接口)、providers/bilibili
              (WS+auth+zlib 解包+DANMU_MSG,经 getConf 避风控)、providers/douyin(桩)、注册表
  translation/ 翻译:types(语言表)、prompt(防注入协议)、translator(切块/容错)、ocr(AI 视觉
              识别优先+本地兜底)、TranslationPanel
  ui/         ControlBar(工具栏,自带热区注册)、CommandPanel(命令面板)、UtilityCard(任务浮层卡)
  storage/    持久化:configStore / historyStore(jsonl 分集+收藏) / memoryStore(事实+口味统计) /
              storyStore(角色世界:事件线/连续剧情/关系) / interactionStore(互动账本+降频记账) /
              memoStore(备忘) / prefetchStore(预生成缓冲);全部写操作走 writeLock 读改写锁,失败静默
  stage/      表现层:CharacterSprite(立绘交叉淡入+CSS 动画)、Bubble、icons、spriteSets(素材注册表)
  input/      pointerManager:穿透窗口的核心——Rust 轮询全局光标,命中已注册热区才恢复交互
src-tauri/
  src/lib.rs            窗口 NOACTIVATE 切换、光标轮询线程、插件注册(单实例/fs/http/log)
  src/audio_capture.rs  WASAPI 环回录音(按进程/整系统),OBS 式录制目标列表,结束事件回传前端
  src/capture.rs        冻结全屏→框选裁剪→写剪贴板(WDA_EXCLUDEFROMCAPTURE 角色不进截图)
  src/ocr.rs            剪贴板图片→文本行(Windows 自带 OCR,专用 STA 线程)+ PNG base64 导出(供视觉模型)
  src/env.rs            桌面快照:电量/前台应用(类别+进程名,可选窗口标题)/全屏/键鼠空闲/媒体在播/CPU/内存
  src/desktop_ops.rs    桌面确定性操作:桌面文件清单、剪贴板文本、打开网址/文件、启动应用、
                        媒体键、音量/静音(IAudioEndpointVolume)、窗口管理、系统通知(双端硬校验)
```

**命名约定:`A/B/C` 是 speaker 槽位标识**(LLM 协议、音色/反应键、历史落盘专用);
`甲/乙/丙` 只是默认角色名,用户改名后所有 prompt 一律用配置名——`persona.ts` 的
`namingDiscipline()` 统一注入称呼与性别纪律(指令/旧素材里的"甲/乙/丙"自动映射,
代词他/她严格按 `genders` 配置)。

**关键设计:穿透窗口。** 窗口铺满主屏且默认 `WS_EX_NOACTIVATE` + 忽略鼠标事件;
Rust 以 ~80Hz 推送全局光标坐标,前端把物理像素换算成窗口逻辑坐标做热区命中,
命中才 `setIgnoreCursorEvents(false)`。**任何可点元素都必须注册热区,否则彻底点不到**——
工具栏按钮由 `ui/ControlBar` 自行注册,新增面板时在 `App.tsx` 挂 `registerHitRegion`,
新增工具入口请注册进 `features/commands`(命令面板),不再往工具栏加按钮。

**统一运行状态:** 演出/面板/截图/录音状态全部收在 `runtime/runtimeMode`,是否可点播/聊天/
主动说话都问它拿;主动行为(闲聊/提醒/重放)只允许 `runtime/proactiveScheduler` 发起,
TTS 按 `chat < performance < utility < proactive` 通道仲裁,勿扰时全静(提醒卡片照弹)。

**LLM 网络:** 请求统一走 `tauri-plugin-http`(Rust 侧,无 CORS),capabilities 放行预设厂商域与
`http://*`(本地 Ollama/LM Studio 等);未放行的自定义 https 端点自动回落原生 fetch。
戳一戳吐槽/聊天回复等纯文本调用不启用 `response_format`,端点不支持 json 模式时 400 自动降级重试。

**数据落盘** (`%APPDATA%/dev.virtualcharacter.app/data/`):
`config.json`(应用配置)· `memory.json`(事实/口味/计数)· `story.json`(角色世界:老梗/事件线/剧情/关系)
· `interactions.json`(互动账本+主动行为降频计数)· `memos.json`(备忘)
· `history/yyyy-MM-dd.jsonl`(演出史)· `favorites.json`(收藏,独立于历史,删历史不波及)
· `prefetch.json`(预生成缓冲)· `audio-cache/`(语音缓存)· `voice-captures/`(克隆参考录音)。

## 开发

```bash
pnpm install
pnpm tauri dev     # 桌面运行(含穿透窗口;浏览器 pnpm dev 仅可调 UI,存储降级 localStorage)
pnpm build         # 类型检查 + 前端构建
pnpm tauri build   # 打包安装程序
pnpm test          # 全量测试(交付前跑一次)
pnpm test:fast     # 快速冒烟:协议/配置/气泡/工具/运行时等高频修改面(开发反馈用)
pnpm test:bubble   # 气泡引擎与主题
pnpm test:shard -- --test-shard=1/4 tests/*.test.mjs   # 本地手动分片(与 CI 同机制)
```

配置运行时在设置面板改,也可直接编辑 `data/config.json` 后重启;
`apiKey` 为空时播放按钮会气泡引导去设置,不会发起无谓请求。

## 文档

- `docs/立绘规范.md` — 角色素材的完整制作/替换规范(画布、对齐、命名、AI 生成管线)。
