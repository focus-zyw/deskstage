# AGENTS.md · 给 AI 会话的工作约定

桌面双人情景剧角色(桌宠):**Tauri 2 + React 19 + TypeScript + Vite**,Rust 侧负责窗口
穿透、光标轮询与 WASAPI 声音捕获。功能全景看 `README.md`,各系统设计文档在 `docs/`。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` / `pnpm tauri dev` | 前端调试 / 桌面端联调 |
| `pnpm build` | `tsc -b && vite build`,交付前必跑 |
| `pnpm lint` | oxlint,`--deny-warnings`,0 警告是底线 |
| `pnpm test` | 全量测试(~18s;98 直载 + 9 vite mock 组) |
| `pnpm test:fast` | 14 个纯逻辑快测,日常迭代用这个 |
| `node --import ./tests/_tsxSetup.mjs --test tests/xxx.test.mjs` | 跑单个测试文件 |
| `cargo test`(src-tauri 下) | Rust 侧行为矩阵 |

## 测试(详见 docs/测试编写约定.md)

- 新测试**不启动 Vite**:src 模块用原生 `await import('../src/...ts')` 放在 `before()` 里;
  依赖注入优先,localStorage 用内存桩。
- `tests/_tsxSetup.mjs` + `tests/_envHook.mjs` 是所有直载文件的加载前置,勿改名勿绕过。
- 只有 mock `@tauri-apps/*` / react jsx-runtime 才允许 vite 自举(现有 9 个这类文件);
  **那 9 个文件里的 createServer/插件块就是 mock 本体,删了会以真实 API 裸奔的方式坏掉**。
- 改动后跑 `pnpm test`;收尾全量回归放后台跑完看结果,不要同步阻塞等待。

## 语言与提交

- 注释、文档、提交信息、测试名**全部中文**。
- 提交格式:`type(scope): 标题——详细说明`(feat/fix/docs/perf/refactor;scope 取模块域,
  如 crosstalk/voice/memory/test)。正文写清动机与权衡,一行说一件事。

## 行尾(CRLF)——Windows 仓库的惯用坑

- 仓库索引统一 LF(`.gitattributes` 已定 `eol=lf`),但本机 `core.autocrlf=true`、
  历史工作区 CRLF/LF 混杂:**处理仓库文件的脚本不能假设行尾**。
- 写 codemod/正则/一次性脚本时:行尾锚定一律 `\r?\n`,或先把文件统一 `\r\n → \n` 再处理;
  正则字面量里的 `//` 记得转义成 `\/\/`(JS 正则会被提前终止)。
- 判断脚本是否真正生效,看"处理后残留"而不是看它有没有报错——codemod 静默失配是常态。
- 待工作区干净后可跑一次 `git add --renormalize .` 把存量文件统一成 LF
  (工作区还有未提交改动时**不要跑**,会把别人的改动一起卷进提交)。

## 架构速览(目录 → 职责)

- `src/engine` — LLM 客户端、提示词组装、AI 生成类功能;`src/session` — ChatSession 会话编排
- `src/performer/modes` — 演出模式注册表(模式即纯数据);`src/topic` — 话题池
- `src/groupChat` / `src/live` — 群聊 Actor 系统 / 直播弹幕(Provider 接口统一弹幕源)
- `src/bubble` `src/stage` `src/expression` `src/interaction` — 气泡、立绘舞台、表情、互动层
- `src/memory` `src/world` — 长期记忆、世界模型
- `src/tools` `src/features/commands` — 工具循环与命令面板;`src/settings` — 设置页
- `src/storage` — 本地存储(JSON + localStorage,带迁移);`src/diag` — 链路诊断与会话回放
- `src-tauri` — Rust 壳:窗口穿透、原生指针、WASAPI 捕获

## 硬纪律(违反会真实坏掉的那种)

1. **新增演出模式**(日常/相声平级):用 `.agents/skills/add-mode`,走 MODES 注册表,
   模式即纯数据,不要手写路由分发。
2. **透明 WebView 上的可点热区**必须走 `registerHitRegion` 原生指针注册
   (参照 ControlBar 既有实现),不能把透明层切成可点击;且可交互 UI 的热区
   **必须同时挂 `nativePointerTarget`**——矩形只当拦截闸门,点击归属由
   elementFromPoint 的 DOM 层级决定。只挂矩形不挂归属时,卡片/浮层一旦与
   角色、工具栏的热区矩形重叠,点击会被先注册者截走,按钮永远点不到
   (工具任务卡「知道了」曾因此全废)。
3. **整窗交互(panelsOpen)只允许"临时"面板触发**(需要输入框/键盘焦点者);
   固定(📌)/常驻/粘性面板必须保持穿透、走自身热区,并把归类同步进
   `tests/modeMenuPointer` 守卫测试(穿透交互的不变量在真实桌面上无法自动化
   复现,只能用源码形状守卫锁住)。穿透架构下「打开却不收起的面板」+「靠收起
   恢复穿透」= 整窗永久拦截桌面(固定翻译面板曾因此堵死整个屏幕)。
4. **大改动先出设计方案**:在 `docs/` 建设计文档(仓库既有文化),定稿再动代码。
5. **测试是行为测试**:重构 src 后测试应原样通过;发现"改测试迁就实现"先停下来想。
6. `pnpm lint` 与 `pnpm test` 全绿才算完成;全量回归耗时 ~18s,没有理由跳过。
