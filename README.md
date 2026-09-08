# virtual-character · 桌面双人情景剧角色

Windows 桌面虚拟角色(桌宠)应用:两个 Q 版角色(甲·便利店店员 / 乙·程序员)常驻桌面,
通过全屏透明穿透覆盖层与你的日常操作互不干扰。点 ▶ 就生成一集相声/闲聊,
带 LLM 编剧、TTS 语音、行为偏好学习与长期记忆,还能直接 @角色聊天。

技术栈:**Tauri 2 + React 19 + TypeScript + Vite**,Rust 侧负责窗口穿透、光标轮询与 WASAPI 声音捕获。

## 功能一览

- **点播演出**:日常/相声两种模式(模式注册表化,新增模式零改动),LLM 生成 JSON 台词脚本,
  解析失败自动降级内置剧本;预生成下一轮实现"秒开",话题池随机 + 使用者兴趣介入 + 偏好加权。
- **聊天通道**:点聊天按钮直接对角色说话,`@甲`/`@乙` 指定谁回,轮换应答;
  说话内容后台提取"关于你的长期事实"进入记忆库。
- **记忆系统**:手填画像(称呼/身份/喜好/雷区)+ 机器自动提取的事实(pinned 置顶防遗忘),
  注入所有对话 prompt;行为信号(戳/收藏/重放)反馈到话题权重。
- **语音**:硅基流动 CosyVoice2 合成,甲乙各自音色,两级缓存(内存 blob → 磁盘 base64)逐句预合成;
  支持上传参考音频或直接录制任意应用/系统声音来**克隆音色**。
- **活人感**:待机小动作、倾听倾斜、惊讶脉冲、连戳分级(害羞/生气)、LLM 即兴吐槽、
  时间感知(时段氛围 + 凌晨免打扰)、空闲自动重放历史、自发短聊天。
- **桌面集成**:点击默认不抢焦点(看视频不被打断),角色可拖动/滚轮缩放,工具栏可拖动/收起。

## 架构速览

```
src/
  engine/     LLM 与语音:llmClient(厂商兼容/错误分类)、promptBuilder(人设+画像+协议)、
              tts(CosyVoice2+克隆+缓存)、dialogPrefetch+topicSeeds(预生成/话题池)、timeAware
  performer/  演出层:player(台词队列,LLM/硬编码剧本同一条路)、modes(模式注册表)
  storage/    持久化:configStore / historyStore(jsonl 分集+收藏) / memoryStore(事实+口味统计) /
              prefetchStore(预生成缓冲);全部写操作走 writeLock 读改写锁,失败静默不影响演出
  stage/      表现层:CharacterSprite(立绘交叉淡入+CSS 动画)、Bubble、icons、spriteSets(素材注册表)
  input/      pointerManager:穿透窗口的核心——Rust 轮询全局光标,命中已注册热区才恢复交互
src-tauri/
  src/lib.rs            窗口 NOACTIVATE 切换、光标轮询线程、插件注册(单实例/fs/http/log)
  src/audio_capture.rs  WASAPI 环回录音(按进程/整系统),OBS 式录制目标列表,结束事件回传前端
```

**关键设计:穿透窗口。** 窗口铺满主屏且默认 `WS_EX_NOACTIVATE` + 忽略鼠标事件;
Rust 以 ~80Hz 推送全局光标坐标,前端把物理像素换算成窗口逻辑坐标做热区命中,
命中才 `setIgnoreCursorEvents(false)`。**任何可点元素都必须注册热区,否则彻底点不到**——
新增按钮/面板时务必在 `App.tsx` 挂 `registerHitRegion`。

**LLM 网络:** 请求统一走 `tauri-plugin-http`(Rust 侧,无 CORS),capabilities 放行预设厂商域与
`http://*`(本地 Ollama/LM Studio 等);未放行的自定义 https 端点自动回落原生 fetch。
戳一戳吐槽/聊天回复等纯文本调用不启用 `response_format`,端点不支持 json 模式时 400 自动降级重试。

**数据落盘** (`%APPDATA%/dev.virtualcharacter.app/data/`):
`config.json`(应用配置)· `memory.json`(事实/口味/计数)· `history/yyyy-MM-dd.jsonl`(演出史)
· `favorites.json`(收藏,独立于历史,删历史不波及)· `prefetch.json`(预生成缓冲)
· `audio-cache/`(语音缓存)· `voice-captures/`(克隆参考录音)。

## 开发

```bash
pnpm install
pnpm tauri dev     # 桌面运行(含穿透窗口;浏览器 pnpm dev 仅可调 UI,存储降级 localStorage)
pnpm build         # 类型检查 + 前端构建
pnpm tauri build   # 打包安装程序
```

配置运行时在设置面板改,也可直接编辑 `data/config.json` 后重启;
`apiKey` 为空时播放按钮会气泡引导去设置,不会发起无谓请求。

## 文档

- `docs/立绘规范.md` — 角色素材的完整制作/替换规范(画布、对齐、命名、AI 生成管线)。
