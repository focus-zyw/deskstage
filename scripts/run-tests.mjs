// 统一测试运行器:按文件自举方式分流。
// - 含 `from 'vite'` 的文件:自起 vite dev server 并内联 mock(@tauri-apps/* 等),用原生 node --test 跑;
// - 其余文件:tsx 直接加载 TS/TSX(node --import ./tests/_tsxSetup.mjs),无 vite 启动开销。
// 全量 10~20 分钟 → ~20 秒 的关键就是后者不吃 vite 启动(每文件 ~2s 纯 I/O)。
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const testsDir = fileURLToPath(new URL('../tests/', import.meta.url))
const all = readdirSync(testsDir).filter((f) => f.endsWith('.test.mjs')).sort()
const viteBased = []
const native = []
for (const f of all) {
  const src = readFileSync(join(testsDir, f), 'utf8')
  ;(src.includes("from 'vite'") ? viteBased : native).push(`tests/${f}`)
}

let failed = false
const batches = []
if (native.length) batches.push(['tsx 直载', ['node', ['--import', './tests/_tsxSetup.mjs', '--test', ...native]]])
if (viteBased.length) batches.push(['vite mock 组', ['node', ['--test', ...viteBased]]])

for (const [label, [cmd, args]] of batches) {
  console.log(`\n[${label}] ${args.filter((a) => a.endsWith('.test.mjs')).length} 个文件`)
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false })
  if (r.status !== 0) failed = true
}
process.exit(failed ? 1 : 0)
