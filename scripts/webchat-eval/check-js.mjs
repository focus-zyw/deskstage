// 校验 webchat.ts 内嵌的页面 JS 模板语法(代入 ${...} 插值后做 Function 解析)
import { readFileSync } from 'node:fs'
const src = readFileSync('src/engine/webchat.ts', 'utf8')
// 被模板引用的常量,从源码里提出来供插值代入
const REPLY_SEL = src.match(/const REPLY_SEL = `([\s\S]*?)`/)?.[1] ?? ''
const UTILS_JS = src.match(/const UTILS_JS = `([\s\S]*?)`/)?.[1] ?? ''
const ROOT_SELS_JS = src.match(/const ROOT_SELS_JS = `([\s\S]*?)`/)?.[1] ?? ''

const templates = [...src.matchAll(/const ([A-Z_]+JS) = `([\s\S]*?)`\n/g)]
if (!templates.length) {
  console.log('未找到任何 JS 模板')
  process.exit(1)
}
let failed = false
for (const [, name, body] of templates) {
  const code = body.replace(/\$\{UTILS_JS\}/g, UTILS_JS).replace(/\$\{ROOT_SELS_JS\}/g, ROOT_SELS_JS)
  try {
    const fn = new Function('return (' + code + ')')()
    console.log(name + ' 语法 OK,类型:', typeof fn)
  } catch (e) {
    // SNAP_JS 是表达式体,IIFE 包装检验
    try {
      new Function('return (async () => { const r = await (' + code + ')("x"); })')()
      console.log(name + ' 语法 OK(IIFE),类型: function')
    } catch (e2) {
      console.log(name + ' 语法错误: ' + e.message + ' / ' + e2.message)
      failed = true
    }
  }
}
process.exit(failed ? 1 : 0)
