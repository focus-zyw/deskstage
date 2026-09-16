// 测试专用 load hook:Node 原生没有 Vite 注入的 import.meta.env,
// 引用它的模块(props/spriteSets/residentManifest/tts 等的 URL 拼接)会直接 TypeError。
// 这里对包含该引用的模块在转换后的源码前补一行默认值,取值与 Vite 生产构建一致。
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context)
  if (result?.source && !url.includes('node_modules') && result.source.includes('import.meta.env')) {
    const guard =
      "if (typeof import.meta.env === 'undefined') import.meta.env = { MODE: 'production', DEV: false, PROD: true, BASE_URL: '/' };\n"
    return { ...result, source: guard + result.source.toString() }
  }
  return result
}
