import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let VoiceChatCard
let recognitionTestOutcome
const stateWrites = []
const invocations = []

const voice = {
  enabled: true,
  voiceChat: {
    mode: 'ptt',
    deviceId: '',
    vadSensitivityDb: 12,
    silenceMs: 800,
    autoInterrupt: false,
    interruptExtraDb: 6,
  },
  asr: {
    provider: 'siliconflow',
    model: 'FunAudioLLM/SenseVoiceSmall',
    apiKey: 'test-key',
  },
}

before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
    ssr: { noExternal: true },
    plugins: [
      {
        name: 'asr-connection-test-mocks',
        enforce: 'pre',
        resolveId(source, importer) {
          if (source === 'react/jsx-dev-runtime' || source === 'react/jsx-runtime') return '\0mock-jsx-runtime'
          if (source === 'react') return '\0mock-react'
          const owner = importer?.replaceAll('\\', '/') ?? ''
          if (source === './asrTest' && owner.includes('/src/settings/VoiceChatCard.tsx')) return '\0mock-asr-test'
          if (!owner.includes('/src/settings/VoiceChatCard.tsx')) return
          const ids = {
            '@tauri-apps/api/core': '\0mock-tauri',
            '../engine/mic': '\0mock-mic',
            '../engine/asr': '\0mock-asr',
            '../engine/tts/wav': '\0mock-wav',
            '../storage/configStore': '\0mock-config',
            './useSettingsSession': '\0mock-settings',
            './SettingsPrimitives': '\0mock-primitives',
          }
          return ids[source]
        },
        load(id) {
          if (id === '\0mock-jsx-runtime') {
            return `
              export const Fragment = Symbol.for('mock.fragment')
              export const jsx = (type, props, key) => ({ type, key, props: props ?? {} })
              export const jsxs = jsx
              export const jsxDEV = jsx
            `
          }
          if (id === '\0mock-react') {
            return `
              export const useEffect = () => {}
              export const useRef = (current) => ({ current })
              export const useState = (initial) => {
                const index = globalThis.__stateIndex++
                return [initial, (value) => globalThis.__stateWrites.push({ index, value })]
              }
            `
          }
          if (id === '\0mock-asr-test') {
            return `export { recognitionTestOutcome } from '/src/settings/asrTest.ts'`
          }
          if (id === '\0mock-tauri') {
            return `
              export const invoke = async (command) => {
                globalThis.__invocations.push(command)
                await new Promise((resolve) => setTimeout(resolve, 20))
                return { text: '' }
              }
            `
          }
          if (id === '\0mock-mic') {
            return `
              export const MIC_SAMPLE_RATE = 16000
              export const listMics = async () => []
              export const rmsDbfs = () => -120
              export const startMic = async () => ({ stop: async () => {} })
            `
          }
          if (id === '\0mock-asr') return `export const bytesToBase64 = () => 'd2F2'`
          if (id === '\0mock-wav') return `export const pcmToWav = () => new ArrayBuffer(44)`
          if (id === '\0mock-config') return `export const saveConfig = async () => {}`
          if (id === '\0mock-settings') {
            return `export const useSettings = () => ({ voice: globalThis.__voice, setVoice() {}, saveField() {}, flashCard: null })`
          }
          if (id === '\0mock-primitives') {
            return `
              export const SetField = (props) => props.children
              export const SetLine = (props) => props.children
              export const SetSwitch = () => null
              export const SettingsCard = (props) => props.children
            `
          }
        },
      },
    ],
  })
  globalThis.__voice = voice
  globalThis.__stateWrites = stateWrites
  globalThis.__invocations = invocations
  globalThis.__stateIndex = 0
  ;({ VoiceChatCard } = await server.ssrLoadModule('/src/settings/VoiceChatCard.tsx'))
  ;({ recognitionTestOutcome } = await server.ssrLoadModule('/src/settings/asrTest.ts'))
})

after(async () => {
  delete globalThis.__voice
  delete globalThis.__stateWrites
  delete globalThis.__invocations
  delete globalThis.__stateIndex
  await server?.close()
})

function findButton(node, label) {
  if (!node || typeof node !== 'object') return null
  if (node.type === 'button' && node.props?.children === label) return node
  const children = node.props?.children
  for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) {
    const found = findButton(child, label)
    if (found) return found
  }
  return null
}

test('连接测试走 models 轻量端点命令,成功文案不再提静音样本', async () => {
  const tree = VoiceChatCard()
  const button = findButton(tree, '测试连接')
  assert.ok(button, '应找到识别连接测试按钮')

  button.props.onClick()
  const testingState = stateWrites.at(-1)?.value

  await new Promise((resolve) => setTimeout(resolve, 50))
  const outcome = stateWrites.at(-1)?.value
  assert.deepEqual(testingState, { state: 'testing', msg: '正在连接识别服务…' })
  assert.equal(invocations.at(-1), 'asr_test_connection')
  assert.equal(outcome?.state, 'ok')
  assert.match(outcome?.msg ?? '', /^服务可连接,密钥有效,模型在列\(\d+ ms\);识别效果请用「录音识别」验证$/)
  assert.doesNotMatch(outcome?.msg ?? '', /识别返回|:空/)
})

test('真实录音只有非空识别文本才算成功', () => {
  const empty = recognitionTestOutcome('   ', 321)
  assert.equal(empty.state, 'fail')
  assert.match(empty.msg, /未识别到文字/)

  const spoken = recognitionTestOutcome('  今天天气不错  ', 456)
  assert.deepEqual(spoken, { state: 'ok', msg: '识别正常(456 ms):“今天天气不错”' })
})
