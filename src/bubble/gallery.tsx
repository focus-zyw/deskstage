// 气泡模板样例页(dev-only,视觉基线来源):七模板标准场景 + 关键状态组合。
// 仅开发/截图核验用,不进产物;经 `pnpm dev` 后访问 /bubble-gallery.html。
// 每个气泡走真实 Bubble 组件 + 真实主题数据(内置两主题 + 目录默认编译的变体),
// 与舞台同一条 resolve/CSS 链路——基线图即用户所见。
import { createRoot } from 'react-dom/client'
import '../App.css'
import {
  BUILT_IN_BUBBLE_THEMES,
  Bubble,
  BubbleThemeProvider,
  listBubbleTemplates,
  normalizeBubbleTheme,
  type BubbleTemplateId,
  type BubbleThemeV2,
} from './index'

const LONG_TEXT =
  '那天晚上我们聊了很久,从巷口的路灯一直聊到楼下的猫都睡着了,风把窗帘吹得一鼓一鼓,谁也没有先说再见。这一大段就是故意写这么长,看看气泡超过八十个字之后字号会不会自动降下来。'

function themeOf(templateId: BubbleTemplateId, over: Partial<BubbleThemeV2> = {}): BubbleThemeV2 {
  const base = normalizeBubbleTheme({
    version: 2,
    id: 'custom_preview',
    label: '样例',
    templateId,
    material: { id: 'solid', opacity: 0.94, blur: 0 },
    palette: { mode: 'per-speaker', primary: '#7c6cf0', lightness: 'light', speakerStrength: 70 },
  })
  const theme = base ?? BUILT_IN_BUBBLE_THEMES.comic
  return normalizeBubbleTheme({ ...theme, ...over }) ?? theme
}

function Row(props: { title: string; note?: string; theme: BubbleThemeV2; desk?: 'light' | 'dark'; children: React.ReactNode }) {
  return (
    <section className="gal-row">
      <h2>
        {props.title}
        {props.note && <small>{props.note}</small>}
      </h2>
      <div className={`gal-desk desk-${props.desk ?? 'light'}`}>
        <BubbleThemeProvider theme={props.theme}>{props.children}</BubbleThemeProvider>
      </div>
    </section>
  )
}

function Gallery() {
  const templates = listBubbleTemplates()
  return (
    <div className="gal-page">
      <h1>气泡模板样例页(视觉基线)</h1>
      <p className="gal-hint">
        七模板标准场景(统一主色 #7c6cf0)、漫画喊话、云朵长文本、RPG 标签槽、玻璃深浅底、上/下尾巴。
        模板 × 材质兼容矩阵见 docs/气泡工坊V2.md。
      </p>

      {templates.map((tpl, i) => (
        <Row
          key={tpl.id}
          title={`${i + 1}. ${tpl.label}`}
          note={tpl.desc}
          theme={themeOf(tpl.id as BubbleTemplateId, {
            material: { id: tpl.defaultMaterial, opacity: tpl.id === 'caption' ? 0.62 : 0.94, blur: tpl.defaultMaterial === 'glass' ? 12 : 0 },
          })}
        >
          <Bubble text="我跟你说,今天这事不简单!" speaker="A" tailSide="left" />
        </Row>
      ))}

      <Row title="漫画爆发框 · 喊话" note="loud 加大加粗 + neon 辉光" theme={themeOf('comic-burst', { material: { id: 'neon', opacity: 0.95, blur: 0 }, effects: { shadow: 'strong', glow: 55, texture: 0 } })}>
        <Bubble text="你给我站住——!!" speaker="B" loud tailSide="right" />
      </Row>

      <Row title="云朵 · 长文本" note=">80 字自动降字号,圆瓣轮廓不随行数失真" theme={themeOf('cloud', { material: { id: 'gradient', opacity: 0.95, blur: 0 } })}>
        <Bubble text={LONG_TEXT} speaker="C" tailSide="center" />
      </Row>

      <Row title="RPG 文本框 · 标签槽名签" note="tab 名签骑边框 + 内嵌亮线" theme={themeOf('rpg', { material: { id: 'glass', opacity: 0.92, blur: 10 } })}>
        <Bubble text="冒险者在酒馆角落坐下,把地图摊开在桌上。" speaker="A" tailSide="left" />
      </Row>

      <Row title="夜色玻璃 · 深色桌面" note="内置 glass 主题原样" theme={BUILT_IN_BUBBLE_THEMES.glass} desk="dark">
        <Bubble text="深色桌面上也读得清。" speaker="B" tailSide="center" />
      </Row>
      <Row title="夜色玻璃 · 浅色桌面" note="同主题对照" theme={BUILT_IN_BUBBLE_THEMES.glass}>
        <Bubble text="浅色桌面上仍保持轮廓。" speaker="B" tailSide="center" />
      </Row>

      <Row title="柔和对话 · 尾巴朝上(below)" note="角色贴近屏幕顶部时气泡翻到下方" theme={BUILT_IN_BUBBLE_THEMES.comic}>
        <Bubble text="气泡翻到角色下方,尾巴朝上。" speaker="A" below tailSide="left" />
      </Row>
      <Row title="手账贴纸 · 胶带与硬阴影" note="sticker 默认 paper 材质" theme={themeOf('sticker')}>
        <Bubble text="记得把酸奶放进冰箱哦。" speaker="C" tailSide="center" />
      </Row>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Gallery />)
