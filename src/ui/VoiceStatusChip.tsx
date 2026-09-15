// 语音对话状态浮标:「正在听(电平点)/ 正在想 / 正在说 / 麦克风不可用」。
// 直订 voiceSession 快照——runtimeMode 只管排他,phase 事实源在 voiceSession,
// 不经 caps 转发(评审:避免状态三副本)。
// 可交互:点击浮标 = 关闭语音对话(会话唯一常驻可见控件;穿透窗口下必须注册
// 热区才能收到点击,见 pointerManager 铁律)。命令面板/热键开关与这里同源。
import { useEffect, useRef, useState } from 'react'
import { getActiveVoiceSession, useVoiceSession } from '../session/voiceSession'
import { registerHitRegion } from '../input/pointerManager'

const LABEL: Record<string, string> = {
  listening: '正在听',
  transcribing: '正在想',
  thinking: '正在想',
  speaking: '正在说',
  'mic-lost': '麦克风不可用',
}

export function VoiceStatusChip() {
  const voice = useVoiceSession()
  const chipRef = useRef<HTMLDivElement | null>(null)
  const [hover, setHover] = useState(false)

  // 命中区注册:phase=off 时组件不渲染,随卸载自动注销。
  // 浮标居中定位,宽度随提示文字变化会挪动左缘——label/note 变化时重注册刷新矩形
  const active = voice.phase !== 'off'
  const label = LABEL[voice.phase] ?? voice.phase
  useEffect(() => {
    if (!active) return
    return registerHitRegion('voice-chip', {
      getRect: () => chipRef.current!.getBoundingClientRect(),
      nativePointerTarget: () => chipRef.current,
    })
  }, [active, label, voice.note])

  if (!active) return null
  // 收音电平 -100~0 dBFS → 0~1:电平点随说话呼吸
  const glow = voice.phase === 'listening' ? Math.max(0, Math.min(1, (voice.level + 100) / 40)) : 0
  const stop = () => void getActiveVoiceSession()?.stop()
  return (
    <div
      ref={chipRef}
      onClick={stop}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="点击关闭语音对话"
      style={{
        position: 'fixed',
        top: 52,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 12px',
        borderRadius: 999,
        background: hover ? 'rgba(30,26,44,.85)' : 'rgba(20,18,30,.72)',
        border: `1px solid ${hover ? 'rgba(255,120,120,.55)' : 'rgba(255,255,255,.16)'}`,
        color: 'rgba(255,255,255,.92)',
        fontSize: 12,
        lineHeight: '16px',
        cursor: 'pointer',
        pointerEvents: 'auto',
        zIndex: 60,
        userSelect: 'none',
        transition: 'background .12s linear, border-color .12s linear',
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background:
            voice.phase === 'mic-lost'
              ? '#e05555'
              : voice.phase === 'speaking'
                ? '#7c5cff'
                : voice.phase === 'listening'
                  ? '#4cc38a'
                  : '#ff9f43',
          opacity: voice.phase === 'listening' ? 0.35 + glow * 0.65 : 1,
          boxShadow: glow > 0.05 ? `0 0 ${Math.round(glow * 10)}px rgba(76,195,138,.9)` : 'none',
          transition: 'opacity .12s linear',
        }}
      />
      {label}
      {voice.note && (
        <span style={{ color: 'rgba(255,255,255,.6)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {voice.note}
        </span>
      )}
      {/* 关闭示意:整颗浮标都是关闭热区,✕ 只承担可见性 */}
      <span
        style={{
          marginLeft: 2,
          color: hover ? 'rgba(255,140,140,.95)' : 'rgba(255,255,255,.55)',
          fontSize: 11,
        }}
      >
        ✕
      </span>
    </div>
  )
}
