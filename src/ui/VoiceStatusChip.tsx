// 语音对话状态浮标:「正在听(电平点)/ 正在想 / 正在说 / 麦克风不可用」。
// 直订 voiceSession 快照——runtimeMode 只管排他,phase 事实源在 voiceSession,
// 不经 caps 转发(评审:避免状态三副本)。纯装饰,pointer-events:none 不碰穿透语义。
import { useVoiceSession } from '../session/voiceSession'

const LABEL: Record<string, string> = {
  listening: '正在听',
  transcribing: '正在想',
  thinking: '正在想',
  speaking: '正在说',
  'mic-lost': '麦克风不可用',
}

export function VoiceStatusChip() {
  const voice = useVoiceSession()
  if (voice.phase === 'off') return null
  const label = LABEL[voice.phase] ?? voice.phase
  // 收音电平 -100~0 dBFS → 0~1:电平点随说话呼吸
  const glow = voice.phase === 'listening' ? Math.max(0, Math.min(1, (voice.level + 100) / 40)) : 0
  return (
    <div
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
        background: 'rgba(20,18,30,.72)',
        border: '1px solid rgba(255,255,255,.16)',
        color: 'rgba(255,255,255,.92)',
        fontSize: 12,
        lineHeight: '16px',
        pointerEvents: 'none',
        zIndex: 60,
        userSelect: 'none',
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
    </div>
  )
}
