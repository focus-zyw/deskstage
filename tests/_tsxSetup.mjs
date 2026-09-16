// 测试统一入口:tsx 负责解析 TS/TSX 与无扩展名导入;_envHook 兜底 import.meta.env。
// 用法:node --import ./tests/_tsxSetup.mjs --test tests/xxx.test.mjs
// 必须指向 tsconfig.app.json(solution-style 的根 tsconfig 没有 jsx 字段,
// 否则 tsx 退回 classic JSX,组件报 "React is not defined")。
process.env.TSX_TSCONFIG_PATH ??= await (async () => {
  const { fileURLToPath } = await import('node:url')
  return fileURLToPath(new URL('../tsconfig.app.json', import.meta.url))
})()
const { register } = await import('node:module')
await import('tsx/esm')
register('./_envHook.mjs', import.meta.url)
