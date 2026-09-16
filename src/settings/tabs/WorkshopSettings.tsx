// 角色工坊:A/B 立绘素材自定义。每张贴图(动作图/变体图)可单独替换为本地
// PNG/WebP(保留透明通道,自动等比缩到 ≤1024px、编码 ≤1MB),也可一键还原默认。
// 生效机制:spriteFileSrc 是立绘 URL 唯一拼装点,覆盖缓存命中即用 data URL——
// 本页预览与桌面舞台同源,所见即所得;清除即还原打包内默认素材。
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  SPRITE_SETS,
  UTILITY_ACTIONS,
  spriteFileSrc,
  spriteFileWhitelist,
  subscribeSpriteOverrides,
  spriteOverridesVersion,
  type SpriteSet,
} from '../../stage/spriteSets'
import {
  MAX_SPRITE_DATA_URL,
  clearAllSpriteOverrides,
  clearSpriteOverride,
  listSpriteOverrides,
  saveSpriteOverride,
  type SpriteSlot,
} from '../../storage/spriteOverrideStore'
import { useConfigSnapshot } from '../../storage/configStore'
import { SettingsCard } from '../SettingsPrimitives'

/** 上传图 → 透明 PNG data URL:等比缩到最长边 ≤1024;超 1MB 逐级缩放重试 */
async function prepareSpriteDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('图片解码失败'))
      el.src = url
    })
    const MAX_SIDE = 1024
    const longSide = Math.max(img.naturalWidth, img.naturalHeight)
    let scale = longSide > MAX_SIDE ? MAX_SIDE / longSide : 1
    for (;;) {
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('画布不可用')
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height) // 不填底色:保留透明
      const dataUrl = canvas.toDataURL('image/png')
      if (dataUrl.length <= MAX_SPRITE_DATA_URL || scale <= 0.2) return dataUrl
      scale *= 0.8
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}

interface SpriteCell {
  file: string
  /** 展示名(idle.png → idle;变体 idle-look.png → idle-look) */
  label: string
  /** 点击缩略图时预览用动作(基础动作 = 本动作;变体 = 归属动作) */
  action: string
}

function cellGroups(set: SpriteSet): { title: string; cells: SpriteCell[] }[] {
  const variantCells: SpriteCell[] = []
  for (const action of set.actions) {
    for (const v of set.variants?.[action] ?? []) {
      if (v.file !== `${action}.png`) variantCells.push({ file: v.file, label: v.file.replace('.png', ''), action })
    }
  }
  return [
    {
      title: '动作立绘',
      cells: set.actions.filter((a) => !(UTILITY_ACTIONS as readonly string[]).includes(a)).map((a) => ({ file: `${a}.png`, label: a, action: a })),
    },
    { title: '工具姿势(本地流程专用)', cells: UTILITY_ACTIONS.map((a) => ({ file: `${a}.png`, label: a, action: 'idle' })) },
    { title: '待机/说话变体', cells: variantCells },
  ]
}

export function WorkshopSettings() {
  const names = useConfigSnapshot().names
  const spriteVersion = useSyncExternalStore(subscribeSpriteOverrides, spriteOverridesVersion)
  const [slot, setSlot] = useState<SpriteSlot>('a')
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [previewFile, setPreviewFile] = useState('idle.png')
  const [uploadTarget, setUploadTarget] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const set = SPRITE_SETS[slot === 'a' ? 'A' : 'B']

  // 覆盖版本变化(本页操作 / 主窗操作 / 启动预载完成)都重拉本槽覆盖表
  useEffect(() => {
    void listSpriteOverrides(slot).then(setOverrides)
  }, [slot, spriteVersion])

  const groups = useMemo(() => cellGroups(set), [set])
  const customCount = Object.keys(overrides).length

  async function onPickFile(file: File | null) {
    const target = uploadTarget
    setUploadTarget(null)
    if (!file || !target) return
    setBusy(true)
    setError('')
    setNote('')
    try {
      const dataUrl = await prepareSpriteDataUrl(file)
      const err = await saveSpriteOverride(slot, target, dataUrl)
      if (err) setError(`${target}:${err}`)
      else setNote(`已替换 ${target}`)
    } catch (e) {
      setError(`读取图片失败:${String((e as Error)?.message ?? e).slice(0, 100)}`)
    } finally {
      setBusy(false)
    }
  }

  async function onClear(file: string) {
    setError('')
    setNote('')
    await clearSpriteOverride(slot, file)
    setNote(`${file} 已还原默认`)
  }

  async function onClearAll() {
    setError('')
    setNote('')
    await clearAllSpriteOverrides(slot)
    setNote(`角色${slot.toUpperCase()}的全部立绘已还原默认`)
  }

  const segBtn = (s: SpriteSlot, label: string) => (
    <button
      key={s}
      className={`seg-btn${slot === s ? ' on' : ''}`}
      onClick={() => {
        setSlot(s)
        setPreviewFile('idle.png')
      }}
    >
      {label}
    </button>
  )

  const cell = (c: SpriteCell) => {
    const custom = overrides[c.file]
    return (
      <div
        key={c.file}
        style={{
          border: '1px solid var(--panel-border, #8884)',
          borderRadius: 10,
          padding: 6,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          background: custom ? 'color-mix(in srgb, #3d8bd4 12%, transparent)' : undefined,
        }}
      >
        <button
          title="点击放大预览"
          onClick={() => setPreviewFile(c.file)}
          style={{ position: 'relative', padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }}
        >
          <img
            src={spriteFileSrc(set, c.file)}
            alt={c.label}
            style={{ width: '100%', height: 84, objectFit: 'contain', display: 'block' }}
          />
          {custom && (
            <span
              style={{
                position: 'absolute',
                top: 2,
                right: 2,
                fontSize: 10,
                padding: '1px 5px',
                borderRadius: 8,
                background: '#3d8bd4',
                color: '#fff',
              }}
            >
              自定义
            </span>
          )}
        </button>
        <div style={{ fontSize: 11, opacity: 0.75, textAlign: 'center' }}>{c.label}</div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="mem-btn" disabled={busy} style={{ flex: 1, fontSize: 11 }} onClick={() => {
            setUploadTarget(c.file)
            fileRef.current?.click()
          }}>
            替换
          </button>
          {custom && (
            <button className="mem-btn" disabled={busy} style={{ flex: 1, fontSize: 11 }} onClick={() => void onClear(c.file)}>
              还原
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <>
      <SettingsCard card="角色工坊" flash={undefined} title="角色工坊" desc="替换 A/B 的立绘素材;桌面舞台立即生效,默认素材随时可还原">
        <div className="seg-group" role="group">
          {segBtn('a', `角色A(${names.a})`)}
          {segBtn('b', `角色B(${names.b})`)}
        </div>
        <div className="set-note">
          已自定义 {customCount} / {spriteFileWhitelist(set).size} 张。图片自动等比缩到 ≤1024px 并保留透明背景(PNG/WebP),
          建议各动作使用同一画布、头脚对齐,否则切换时会跳位。
        </div>
        <div className="set-actions">
          <button className="panel-btn" disabled={busy || customCount === 0} onClick={() => void onClearAll()}>
            全部还原此角色
          </button>
        </div>
        {note && <div className="set-note">{note}</div>}
        {error && <div className="set-note">{error}</div>}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/webp"
          style={{ display: 'none' }}
          onChange={(e) => {
            void onPickFile(e.target.files?.[0] ?? null)
            e.target.value = ''
          }}
        />
      </SettingsCard>

      <SettingsCard card="立绘预览" flash={undefined} title="立绘预览" desc="点击上方任一贴图可放大预览;与桌面舞台同源">
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div
            style={{
              minWidth: 200,
              minHeight: 280,
              display: 'flex',
              alignItems: 'flex-end',
              justifyContent: 'center',
              background: 'color-mix(in srgb, currentColor 6%, transparent)',
              borderRadius: 12,
              padding: 12,
            }}
          >
            <img
              src={spriteFileSrc(set, previewFile)}
              alt={previewFile}
              style={{ height: 320, objectFit: 'contain', display: 'block' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="set-note">预览贴图(与桌面舞台同源;点上方任一缩略图可看变体)</div>
            <div className="seg-group" role="group" style={{ flexWrap: 'wrap' }}>
              {set.actions.map((a) => (
                <button key={a} className={`seg-btn${previewFile === `${a}.png` ? ' on' : ''}`} onClick={() => setPreviewFile(`${a}.png`)}>
                  {a}
                </button>
              ))}
            </div>
          </div>
        </div>
      </SettingsCard>

      {groups.map((g) =>
        g.cells.length > 0 ? (
          <SettingsCard key={g.title} card={g.title} flash={undefined} title={g.title} desc={`共 ${g.cells.length} 张`}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))', gap: 10 }}>
              {g.cells.map(cell)}
            </div>
          </SettingsCard>
        ) : null,
      )}
    </>
  )
}
