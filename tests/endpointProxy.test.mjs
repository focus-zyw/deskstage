import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let requestEndpoint

before(async () => {
  globalThis.__endpointProxyMock = {
    async invoke(command, args) {
      assert.equal(command, 'endpoint_request')
      args.onChunk.onmessage(new TextEncoder().encode('{"error":"bad key"}'))
      args.onChunk.onmessage(new Uint8Array(0))
      return 401
    },
  }

  server = await createServer({
    appType: 'custom',
    logLevel: 'silent',
    ssr: { noExternal: ['@tauri-apps/api'] },
    plugins: [
      {
        name: 'endpoint-proxy-mocks',
        enforce: 'pre',
        resolveId(id) {
          if (id === '@tauri-apps/api/core') return '\0mock-tauri-core'
        },
        load(id) {
          if (id === '\0mock-tauri-core') {
            return `
              export class Channel { onmessage = () => {} }
              export const invoke = (command, args) => globalThis.__endpointProxyMock.invoke(command, args)
            `
          }
        },
      },
    ],
  })
  ;({ requestEndpoint } = await server.ssrLoadModule('/src/engine/endpointProxy.ts'))
})

after(async () => {
  delete globalThis.__endpointProxyMock
  await server?.close()
})

test('Rust 返回数字状态码时保留真实 HTTP 状态和响应正文', async () => {
  await assert.rejects(
    requestEndpoint('llm', '/chat/completions', { body: '{}' }),
    (error) => error.message === 'HTTP 401: {"error":"bad key"}' && error.status === 401,
  )
})
