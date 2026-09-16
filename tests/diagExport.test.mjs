// 诊断包导出必须落在 Tauri 授权的 appData/data 内，Windows 路径不能因缺少分隔符越界。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'

let writeDiagExportFile

before(async () => {
  ;({ writeDiagExportFile } = await import('../src/diag/exportFile.ts'))
})


test('Windows appDataDir 无尾分隔符时仍导出到授权的 data 子目录', async () => {
  const calls = { mkdir: [], write: [] }
  const join = async (...parts) => parts.join('/').replace(/\\/g, '/').replace(/\/+/g, '/')
  const file = await writeDiagExportFile('{}', {
    appDataDir: async () => 'C:\\Users\\tester\\AppData\\Roaming\\dev.virtualcharacter.app',
    join,
    mkdir: async (path, options) => calls.mkdir.push({ path, options }),
    writeTextFile: async (path, contents) => calls.write.push({ path, contents }),
    now: () => 123,
  })

  assert.equal(file, 'C:/Users/tester/AppData/Roaming/dev.virtualcharacter.app/data/diag-export-123.json')
  assert.deepEqual(calls.mkdir, [{
    path: 'C:/Users/tester/AppData/Roaming/dev.virtualcharacter.app/data',
    options: { recursive: true },
  }])
  assert.deepEqual(calls.write, [{ path: file, contents: '{}' }])
})
