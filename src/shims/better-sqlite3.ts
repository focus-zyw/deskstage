// better-sqlite3 webview 桩:mem0ai OSS 的 ESM 产物顶层静态 import 它,而桌面
// webview 里没有 Node 原生模块。运行时路径上我们 disableHistory 并注入自定义
// VectorStore(见 src/cold/mem0Database.ts),Database 永不被构造——这个桩只让
// 模块导入可解析。由 vite.config.ts 的 resolve.alias 指向。
export default class Database {}
