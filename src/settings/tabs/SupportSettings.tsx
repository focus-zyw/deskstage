// 支持作者:收款码 + 心意扭蛋机 + 心意图鉴,独立分页(「支持」组)。
// 数据是 data/support.json 账本(自报金额落账、抽奖消耗次数、图鉴收集),
// 与设置草稿无关,挂载自取 + 写路径回填(同收藏/历史页套路)。
// 抽奖演出:本轮最高稀有度的感谢语经 bridge.onSupportThanks 交给舞台角色当场说出,
// {name} 在这里用已落盘配置解析好再交出去,App 侧只管呈现。
import { useEffect, useRef, useState } from 'react'
import { useSettings } from '../useSettingsSession'
import { SettingsCard } from '../SettingsPrimitives'
import { useConfigSnapshot } from '../../storage/configStore'
import { addSupport, drawPrizes, getSupport, resetSupport } from '../../storage/supportStore'
import {
  RARITY_META,
  RARITY_ORDER,
  THANKS_POOL,
  resolveSupportText,
  type SupportPrize,
} from '../../features/support/pool'
import { amountToDraws, MAX_SINGLE_YUAN, type SupportLedger } from '../../features/support/gacha'

/** 收款码图片:替换 public/support/ 下的文件即可(先用 SVG 占位,换成自己的码后同名覆盖或改这里) */
const QR_WECHAT = `${import.meta.env.BASE_URL}support/wechat-qr.svg`
const QR_ALIPAY = `${import.meta.env.BASE_URL}support/alipay-qr.svg`

/** 金额快捷档(元) */
const PRESETS = [5, 10, 20, 50]

/** 图鉴排序:稀有度从低到高,同档按池子原序 */
const GALLERY = [...THANKS_POOL].sort(
  (a, b) => RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity),
)

/** 本轮最高稀有度(舞台演出按它定规格) */
function topPrizeOf(prizes: SupportPrize[]): SupportPrize | null {
  let top: SupportPrize | null = null
  for (const p of prizes) {
    if (!top || RARITY_ORDER.indexOf(p.rarity) > RARITY_ORDER.indexOf(top.rarity)) top = p
  }
  return top
}

export function SupportSettings() {
  const { bridge, flashCard } = useSettings()
  const cfg = useConfigSnapshot()
  const [ledger, setLedger] = useState<SupportLedger | null>(null)
  const [amountText, setAmountText] = useState('10')
  const [claimFlash, setClaimFlash] = useState('')
  const claimTimer = useRef(0)
  const [results, setResults] = useState<SupportPrize[]>([])
  const [revealCount, setRevealCount] = useState(0)
  const [spinning, setSpinning] = useState(false)
  const spinTimers = useRef<number[]>([])
  const [resetArmed, setResetArmed] = useState(false)
  const resetTimer = useRef(0)

  useEffect(() => {
    void getSupport().then(setLedger)
    // 卸载清场:翻卡与提示的定时器不留孤儿
    return () => {
      window.clearTimeout(claimTimer.current)
      window.clearTimeout(resetTimer.current)
      for (const t of spinTimers.current) window.clearTimeout(t)
    }
  }, [])

  const parsedAmount = Number(amountText)
  const claimDraws = amountToDraws(parsedAmount)

  /** 自报金额落账:信任模式,点领取即入账并加次数 */
  async function claim() {
    if (claimDraws <= 0) return
    const next = await addSupport(parsedAmount)
    setLedger(next)
    setClaimFlash(`+${claimDraws} 抽`)
    window.clearTimeout(claimTimer.current)
    claimTimer.current = window.setTimeout(() => setClaimFlash(''), 2500)
  }

  /** 抽奖:锁内滚动(次数/保底一致)→ 前台逐张翻卡 → 最高稀有度上台答谢 */
  async function draw(n: number) {
    if (spinning || !ledger || ledger.drawsLeft <= 0) return
    const want = Math.min(n, ledger.drawsLeft)
    setSpinning(true)
    setResults([])
    setRevealCount(0)
    for (const t of spinTimers.current) window.clearTimeout(t)
    spinTimers.current = []
    const { ledger: next, prizes } = await drawPrizes(want)
    setLedger(next)
    setResults(prizes)
    // 十连逐张翻出,180ms/张;全部翻完解除动画锁
    for (let i = 1; i <= prizes.length; i++) {
      spinTimers.current.push(window.setTimeout(() => setRevealCount(i), i * 180))
    }
    spinTimers.current.push(
      window.setTimeout(() => setSpinning(false), prizes.length * 180 + 260),
    )
    const top = topPrizeOf(prizes)
    if (top) {
      bridge.onSupportThanks({
        rarity: top.rarity,
        text: resolveSupportText(top.text, cfg.userProfile.userName),
      })
    }
  }

  /** 清空支持记录:3 秒内再点确认(与退出程序同款两段确认) */
  function requestReset() {
    if (resetArmed) {
      setResetArmed(false)
      void resetSupport()
        .then(getSupport)
        .then(setLedger)
      setResults([])
      setRevealCount(0)
      return
    }
    setResetArmed(true)
    window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(() => setResetArmed(false), 3000)
  }

  const ledgerView = ledger ?? {
    version: 1 as const,
    totalSupportedYuan: 0,
    drawsLeft: 0,
    totalDraws: 0,
    pity: { sinceEpic: 0, sinceLegendary: 0 },
    collection: {},
  }
  const ownedCount = GALLERY.filter((p) => ledgerView.collection[p.id]).length
  const galleryComplete = ownedCount === GALLERY.length
  const hasLegendary = results.some((p) => p.rarity === 'legendary')

  return (
    <>
      <SettingsCard
        card="请作者喝杯奶茶"
        flash={flashCard}
        title="请作者喝杯奶茶"
        desc="本应用完全免费;这里的每一分支持都用来续费服务器和买奶茶"
      >
        <div className="gacha-qr-row">
          <figure className="gacha-qr">
            <img src={QR_WECHAT} alt="微信收款码" />
            <figcaption>微信</figcaption>
          </figure>
          <figure className="gacha-qr">
            <img src={QR_ALIPAY} alt="支付宝收款码" />
            <figcaption>支付宝</figcaption>
          </figure>
          <div className="gacha-qr-note">
            <p>扫码请作者喝杯奶茶,凭心意自报金额——</p>
            <p>
              <strong>1 元 = 1 次抽奖</strong>,在下面的心意扭蛋机里抽角色感谢语,
              附赠保底(10 抽必出史诗,40 抽必出传说)。
            </p>
            <p className="set-hint">全凭自觉,角色只负责说谢谢~</p>
          </div>
        </div>
        <div className="gacha-claim-block">
          <div className="gacha-claim-copy">
            <span className="set-label">我支持了</span>
            <span className="set-hint">选个档位或自己填(单笔最高 ¥{MAX_SINGLE_YUAN}),点领取即到账</span>
          </div>
          <div className="gacha-claim">
            <div className="seg-group">
              {PRESETS.map((v) => (
                <button
                  key={v}
                  className={`seg-btn${amountText === String(v) ? ' on' : ''}`}
                  onClick={() => setAmountText(String(v))}
                >
                  ¥{v}
                </button>
              ))}
            </div>
            <input
              type="number"
              min={1}
              max={2000}
              step={1}
              className="break-min-input"
              title="支持金额(元)"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
            />
            <button className="panel-btn primary" disabled={claimDraws <= 0} onClick={() => void claim()}>
              我已支持 · 领取 {claimDraws} 抽
            </button>
            {claimFlash && <span className="gacha-flash">{claimFlash}</span>}
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        card="心意扭蛋机"
        flash={flashCard}
        title="心意扭蛋机"
        desc="每次消耗 1 抽,扭出一句角色感谢语;十连按 180ms/张逐张翻出"
      >
        <div className="gacha-machine-row">
          <div className={`gacha-machine${spinning ? ' shaking' : ''}`} aria-hidden="true">
            <div className="gacha-dome">
              <span className="gacha-ball b1" />
              <span className="gacha-ball b2" />
              <span className="gacha-ball b3" />
              <span className="gacha-ball b4" />
            </div>
            <div className="gacha-slot" />
          </div>
          <div className="gacha-side">
            <div className="gacha-stats">
              <span className="gacha-stat-num">{ledgerView.drawsLeft}</span>
              <span className="gacha-stat-label">剩余抽奖</span>
            </div>
            <div className="gacha-btns">
              <button
                className="panel-btn primary"
                disabled={spinning || ledgerView.drawsLeft <= 0}
                onClick={() => void draw(1)}
              >
                单抽
              </button>
              <button
                className="panel-btn primary"
                disabled={spinning || ledgerView.drawsLeft < 10}
                title={ledgerView.drawsLeft < 10 ? '剩余次数不足 10 抽' : '一次抽 10 发'}
                onClick={() => void draw(10)}
              >
                十连
              </button>
            </div>
            <span className="set-hint">
              已支持 ¥{ledgerView.totalSupportedYuan} · 累计 {ledgerView.totalDraws} 抽
            </span>
          </div>
        </div>
        {results.length > 0 && (
          <div className={`gacha-results${hasLegendary ? ' ur-burst' : ''}`}>
            {results.slice(0, revealCount).map((p, i) => (
              <div className={`gacha-card rar-${p.rarity}`} key={`${p.id}-${i}`}>
                <span className="gacha-rarity">{RARITY_META[p.rarity].label}</span>
                <p>{resolveSupportText(p.text, cfg.userProfile.userName)}</p>
              </div>
            ))}
          </div>
        )}
      </SettingsCard>

      <SettingsCard
        card="心意图鉴"
        flash={flashCard}
        title={`心意图鉴(${ownedCount}/${GALLERY.length})`}
        desc="抽到过的感谢语都会留档;集齐全套有作者的小彩蛋"
      >
        <div className="gacha-gallery">
          {GALLERY.map((p) => {
            const entry = ledgerView.collection[p.id]
            return (
              <div
                key={p.id}
                className={`gacha-item rar-${p.rarity}${entry ? '' : ' unknown'}`}
                title={entry ? undefined : '还没抽到过'}
              >
                <span className="gacha-rarity">{RARITY_META[p.rarity].label}</span>
                {entry ? (
                  <>
                    <p>{resolveSupportText(p.text, cfg.userProfile.userName)}</p>
                    <span className="gacha-item-count">×{entry.count}</span>
                  </>
                ) : (
                  <p className="gacha-unknown">？？？？？？</p>
                )}
              </div>
            )
          })}
        </div>
        {galleryComplete && (
          <div className="gacha-egg">
            <strong>作者的话</strong>
            <p>
              能集齐整套感谢语,说明你把扭蛋机摇了不知道多少圈——这份心意比抽到什么都珍贵。
              这个小应用会一直免费更新,谢谢你陪这些角色走下去。
            </p>
          </div>
        )}
        <div className="set-line">
          <div className="set-copy">
            <span className="set-label">清空支持记录</span>
            <span className="set-hint">流水、次数与图鉴一起清,不可恢复</span>
          </div>
          <div className="set-control">
            <button
              className={`panel-btn${resetArmed ? ' primary' : ''}`}
              title={resetArmed ? '再点一次确认清空' : '清空全部支持记录'}
              onClick={requestReset}
            >
              {resetArmed ? '确认清空' : '清空'}
            </button>
          </div>
        </div>
      </SettingsCard>
    </>
  )
}
