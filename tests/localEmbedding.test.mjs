// 本地嵌入服务回归(注入假 request,零网络):地址缺省回退、请求体形态(model
// 填了带上/没填省略)、OpenAI 响应按 index 排序、空输入短路、失败原样上抛
// (上游 mem0Memory 的 fail-open 兜底,这里只保证错误可见)。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { createLocalEmbedding, resolveLocalUrl } = await import('../src/engine/localEmbedding.ts')

test('地址解析:配置值优先,空白回退缺省 llama-server 地址', () => {
  assert.equal(resolveLocalUrl('http://127.0.0.1:9990/v1'), 'http://127.0.0.1:9990/v1')
  assert.equal(resolveLocalUrl('   '), 'http://127.0.0.1:8080/v1')
  assert.equal(resolveLocalUrl(undefined), 'http://127.0.0.1:8080/v1')
})

test('请求体:model 填了带上、没填省略;响应按 index 归位', async () => {
  const calls = []
  const svc = createLocalEmbedding({
    request: async (path, body) => {
      calls.push({ path, body: JSON.parse(body) })
      // 故意乱序返回:index 1 先到,解析后必须按 index 归位
      return JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] })
    },
  })
  const out = await svc.embedBatch(['甲', '乙'], { embedModel: 'bge-small', localUrl: 'http://x/v1' })
  assert.deepEqual(out, [[1, 0], [0, 1]])
  assert.equal(calls[0].path, '/embeddings')
  assert.deepEqual(calls[0].body.input, ['甲', '乙'])
  assert.equal(calls[0].body.model, 'bge-small')
})

test('embedModel 选填:没填就不带 model 字段(llama-server 单模型)', async () => {
  const bodies = []
  const svc = createLocalEmbedding({
    request: async (_path, body) => {
      bodies.push(JSON.parse(body))
      return '{"data":[{"index":0,"embedding":[3]}]}'
    },
  })
  await svc.embedBatch(['一条'], {})
  await svc.embedBatch(['两条'], { embedModel: '   ' })
  assert.equal('model' in bodies[0], false)
  assert.equal('model' in bodies[1], false)
})

test('空输入短路;request 失败原样上抛', async () => {
  const svc = createLocalEmbedding({
    request: async () => {
      throw new Error('连接拒绝')
    },
  })
  assert.deepEqual(await svc.embedBatch([], {}), [])
  await assert.rejects(() => svc.embedBatch(['x'], {}), /连接拒绝/)
})

test('响应不合法:data 缺失或非数组 → 抛错', async () => {
  const svc = createLocalEmbedding({ request: async () => '{"results":[]}' })
  await assert.rejects(() => svc.embedBatch(['x'], {}), /响应不合法/)
})
