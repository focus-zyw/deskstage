//! 页面活性恢复 · 深模块:停滞检测、逐级恢复(软唤醒→激活脉冲)、站点健康与
//! 独立窗口升级判定全部收口在此;generation 只消费 `observe` 给出的动作,
//! 不感知阈值、升级次数与站点健康分数。
//!
//! 不变量(方案 §一):
//! · 软唤醒不切标签页、不抢用户焦点、绝不 reload、绝不重发提示词;
//! · 激活脉冲是一次性短命令(全局节流),不持有锁等待回复;
//! · 只有「页面活着但模型不动」的连续失败才升级独立窗口(§七 前置由调用方校验);
//! · 出现任何进展迹象,计时与次数全部清零(§二);
//! · 一个站点的升级不影响其他站点(健康按站点分账)。

// 阶段 1(只观察)期间,脉冲节流器/站点健康/诊断字段的消费方在阶段 2/3 接线,
// 接线完成后移除本 allow
#![allow(dead_code)]

use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::AskPhase;

// ---------- 类型 ----------

/// 目标标签页落位:复用普通标签页 / 独立窗口(站点持续无法后台生成时)
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TargetPlacement {
    Tab,
    DedicatedWindow,
}

/// 活性梯子给出的恢复动作
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RecoveryAction {
    None,
    SoftWake,
    ActivationPulse,
    PromoteDedicated,
}

/// 一拍页面快照(轮询循环解析 SNAP_JS 后归一化;正文只留指纹与长度,不留原文)
#[derive(Clone)]
pub struct ActivitySnapshot {
    pub count: u64,
    pub text_hash: u64,
    pub text_len: usize,
    pub busy: bool,
    pub input_ready: bool,
    pub turn_error: bool,
    pub visibility: String,
    pub focused: bool,
}

impl ActivitySnapshot {
    /// 正文指纹(FNV 意义不大,标准 Hasher 即可;只为比对变化,非安全用途)
    pub fn text_hash(text: &str) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        text.hash(&mut h);
        h.finish()
    }
}

/// 进展判定(§六):消息数增加 / 文本指纹变化 / 文本长度增长 / busy 由否变是。
/// focused 与 visibility 不参与进展——后台标签页被用户遮挡是常态,不是失败。
pub fn progressed(before: &ActivitySnapshot, after: &ActivitySnapshot) -> bool {
    after.count > before.count
        || after.text_hash != before.text_hash
        || after.text_len > before.text_len
        || (!before.busy && after.busy)
}

/// 一次 observe 的结论:恢复动作 + 应记录的轨迹标记 + 诊断数字
pub struct Observation {
    pub action: RecoveryAction,
    pub marks: Vec<&'static str>,
    /// 距上次进展的毫秒数(诊断)
    pub idle_ms: u64,
    /// 本阶段已执行的唤醒/脉冲次数(诊断)
    pub wake_attempt: u32,
}

impl Observation {
    fn none() -> Self {
        Self {
            action: RecoveryAction::None,
            marks: Vec::new(),
            idle_ms: 0,
            wake_attempt: 0,
        }
    }
}

/// 恢复梯子阈值。首版五站统一默认值(方案 §十二),按真实运行轨迹再分站调整
#[derive(Clone, Copy)]
pub struct ActivityPolicy {
    pub first_soft_wake_ms: u64,
    pub first_pulse_ms: u64,
    pub second_soft_wake_ms: u64,
    pub second_pulse_ms: u64,
    /// 双脉冲耗尽后仍无进展,再给一段确认窗才判定活性失败(独立窗口升级点)
    pub promote_ms: u64,
    pub streaming_soft_wake_ms: u64,
    pub streaming_pulse_ms: u64,
}

impl Default for ActivityPolicy {
    fn default() -> Self {
        Self {
            first_soft_wake_ms: 6_000,
            first_pulse_ms: 15_000,
            second_soft_wake_ms: 30_000,
            second_pulse_ms: 45_000,
            promote_ms: 60_000,
            streaming_soft_wake_ms: 20_000,
            streaming_pulse_ms: 45_000,
        }
    }
}

// ---------- 活性跟踪器(每 ask 一个) ----------

/// 一次生成的活性状态机。所有时刻由调用方传入(`observe`/`note_action` 带 now),
/// 纯状态无时钟依赖,单测直接喂时刻序列
pub struct ActivityTracker {
    policy: ActivityPolicy,
    /// 梯子起点 = 发送确认时刻
    sent_at: Instant,
    /// 上一次判定「有进展」的时刻(WaitingForStart 阶梯时钟)
    last_progress_at: Instant,
    /// 上一次回复文本变化的时刻(流式停摆时钟;生成中 busy 恒真,只看文本)
    last_text_change_at: Instant,
    prev: Option<ActivitySnapshot>,
    soft_wakes: u32,
    pulses: u32,
    stream_soft_wakes: u32,
    stream_pulses: u32,
    last_stream_pulse: Option<Instant>,
    /// 已执行、等待恢复确认的动作("soft_wake"/"pulse"):出现进展时补发 recovered 标记
    armed: Option<&'static str>,
    /// 已上报过升级(只报一次;调用方否决后同样置位,改为受总超时约束)
    promote_reported: bool,
    streaming: bool,
}

impl ActivityTracker {
    pub fn begin(policy: ActivityPolicy, now: Instant) -> Self {
        Self {
            policy,
            sent_at: now,
            last_progress_at: now,
            last_text_change_at: now,
            prev: None,
            soft_wakes: 0,
            pulses: 0,
            stream_soft_wakes: 0,
            stream_pulses: 0,
            last_stream_pulse: None,
            armed: None,
            promote_reported: false,
            streaming: false,
        }
    }

    /// 每拍快照喂入。phase < Sent 时不工作(发送前有独立的激活/重试逻辑)
    pub fn observe(
        &mut self,
        phase: AskPhase,
        snap: &ActivitySnapshot,
        now: Instant,
    ) -> Observation {
        if phase < AskPhase::Sent {
            return Observation::none();
        }
        let mut marks: Vec<&'static str> = Vec::new();

        // 进展判定(与上一拍比较;首拍只建基线)
        let progressed = match &self.prev {
            None => false,
            Some(b) => progressed(b, snap),
        };
        if progressed {
            match self.armed.take() {
                Some("soft_wake") => marks.push("activity:soft_wake_recovered"),
                Some("pulse") => marks.push("activity:pulse_recovered"),
                _ => {}
            }
            // 计时与次数全部清零(§二)
            self.last_progress_at = now;
            self.soft_wakes = 0;
            self.pulses = 0;
            self.stream_soft_wakes = 0;
            self.stream_pulses = 0;
            self.last_stream_pulse = None;
        }

        // 流式切换:回复确认开始生成 = 流式停摆钟归零
        let now_streaming = phase >= AskPhase::ResponseStarted;
        if now_streaming && !self.streaming {
            self.streaming = true;
            self.last_text_change_at = now;
        }
        // 文本实际变化(非空)→ 流式停摆钟归零
        if let Some(b) = &self.prev {
            if snap.text_len > 0 && snap.text_hash != b.text_hash {
                self.last_text_change_at = now;
            }
        }
        self.prev = Some(snap.clone());

        let idle_ms = now
            .saturating_duration_since(self.last_progress_at)
            .as_millis() as u64;
        let wake_attempt = self.soft_wakes + self.pulses;
        let action = if now_streaming {
            self.streaming_ladder(now)
        } else {
            self.waiting_ladder(idle_ms)
        };
        Observation {
            action,
            marks,
            idle_ms,
            wake_attempt,
        }
    }

    /// WaitingForStart 阶梯(§二):6s 软唤醒① → 15s 脉冲① → 30s 软唤醒②
    /// → 45s 脉冲② → 60s(脉冲②后 15s 确认窗)仍无进展 → 升级判定
    fn waiting_ladder(&mut self, idle_ms: u64) -> RecoveryAction {
        let p = &self.policy;
        if self.promote_reported {
            return RecoveryAction::None;
        }
        if idle_ms >= p.promote_ms && self.pulses >= 2 {
            self.promote_reported = true;
            return RecoveryAction::PromoteDedicated;
        }
        if idle_ms >= p.second_pulse_ms && self.pulses < 2 {
            return RecoveryAction::ActivationPulse;
        }
        if idle_ms >= p.second_soft_wake_ms && self.soft_wakes < 2 {
            return RecoveryAction::SoftWake;
        }
        if idle_ms >= p.first_pulse_ms && self.pulses < 1 {
            return RecoveryAction::ActivationPulse;
        }
        if idle_ms >= p.first_soft_wake_ms && self.soft_wakes < 1 {
            return RecoveryAction::SoftWake;
        }
        RecoveryAction::None
    }

    /// 流式阶梯(§六):busy 恒真时只看文本——20s 无文本变化软唤醒,
    /// 45s 起每 45s 一次激活脉冲(喂 3-of-5 规则);不提前重发,受总超时约束
    fn streaming_ladder(&mut self, now: Instant) -> RecoveryAction {
        let stall = now
            .saturating_duration_since(self.last_text_change_at)
            .as_millis() as u64;
        if stall >= self.policy.streaming_pulse_ms {
            let due = self.last_stream_pulse.map_or(true, |t| {
                now.saturating_duration_since(t).as_millis() as u64
                    >= self.policy.streaming_pulse_ms
            });
            if due {
                return RecoveryAction::ActivationPulse;
            }
        }
        if stall >= self.policy.streaming_soft_wake_ms && self.stream_soft_wakes == 0 {
            return RecoveryAction::SoftWake;
        }
        RecoveryAction::None
    }

    /// 派发方回报动作执行结果:被节流器/前置否决(executed=false)不计数,
    /// 梯子下一拍自然重发请求
    pub fn note_action(&mut self, action: RecoveryAction, executed: bool, now: Instant) {
        if !executed {
            return;
        }
        match action {
            RecoveryAction::SoftWake => {
                if self.streaming {
                    self.stream_soft_wakes += 1;
                } else {
                    self.soft_wakes += 1;
                }
                self.armed = Some("soft_wake");
            }
            RecoveryAction::ActivationPulse => {
                if self.streaming {
                    self.stream_pulses += 1;
                    self.last_stream_pulse = Some(now);
                } else {
                    self.pulses += 1;
                }
                self.armed = Some("pulse");
            }
            RecoveryAction::PromoteDedicated | RecoveryAction::None => {}
        }
    }

    /// 调用方否决升级(前置不满足/用户强制标签页模式):不再重复上报,受总超时约束
    pub fn suppress_promotion(&mut self) {
        self.promote_reported = true;
    }

    /// 本轮是否用过激活脉冲(站点健康 3-of-5 规则的输入)
    pub fn used_pulse(&self) -> bool {
        self.pulses > 0 || self.stream_pulses > 0
    }
}

// ---------- 激活脉冲节流器 ----------

/// 全局脉冲节流:两个生成任务同时停滞时避免疯狂切标签页。
/// 只保护激活命令本身,不是前台租约——命令结束立即释放
pub struct PulseCoordinator {
    global_gap: Duration,
    target_gap: Duration,
    last_at: Option<Instant>,
    last_target: Option<String>,
}

impl PulseCoordinator {
    pub fn new() -> Self {
        Self {
            global_gap: Duration::from_millis(1_500),
            target_gap: Duration::from_millis(10_000),
            last_at: None,
            last_target: None,
        }
    }

    /// 全局两次脉冲至少间隔 1.5s;同一标签页至少间隔 10s。
    /// 两个目标同时停滞时,后到的自然让位——轮询 300ms 一拍,
    /// 先停滞者(last_progress_at 更早)先到先得
    pub fn try_acquire(&mut self, target: &str, now: Instant) -> bool {
        if let Some(t) = self.last_at {
            if now.saturating_duration_since(t) < self.global_gap {
                return false;
            }
            if self.last_target.as_deref() == Some(target)
                && now.saturating_duration_since(t) < self.target_gap
            {
                return false;
            }
        }
        self.last_at = Some(now);
        self.last_target = Some(target.to_string());
        true
    }
}

impl Default for PulseCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

// ---------- 站点健康 ----------

/// 站点目标形态:标签页 / 待升级独立窗口 / 独立窗口
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SiteMode {
    Tab,
    DedicatedPending,
    Dedicated,
}

impl SiteMode {
    pub fn label(self) -> &'static str {
        match self {
            SiteMode::Tab => "标签页模式",
            SiteMode::DedicatedPending => "待切换独立窗口",
            SiteMode::Dedicated => "独立窗口模式",
        }
    }
}

/// 用户手动覆盖(设置页;Auto = 无覆盖)。PreferTab 压制自动升级,
/// PreferDedicated 直接独立窗口。自动判断本身不持久化,Edge 重启后重新评估
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ModeOverride {
    PreferTab,
    PreferDedicated,
}

#[derive(Clone)]
pub struct SiteHealth {
    pub mode: SiteMode,
    /// 连续活性失败(仅 Stalled 类;成功清零)
    pub liveness_failures: u8,
    /// 最近 5 轮是否依赖激活脉冲(3-of-5 → 升级)
    pub pulse_required_turns: VecDeque<bool>,
    /// 独立窗口模式下无唤醒/脉冲的连续成功轮数(状态展示用;降级仅手动)
    pub healthy_turns: u16,
    pub promoted_at: Option<Instant>,
    /// 最近一次恢复动作描述(设置页状态行)
    pub last_action: String,
}

impl SiteHealth {
    fn new() -> Self {
        Self {
            mode: SiteMode::Tab,
            liveness_failures: 0,
            pulse_required_turns: VecDeque::new(),
            healthy_turns: 0,
            promoted_at: None,
            last_action: String::new(),
        }
    }
}

/// 站点健康总账:按站点分账,一个站点升级不影响其他站点
#[derive(Default)]
pub struct SiteHealthBook {
    sites: HashMap<String, SiteHealth>,
    overrides: HashMap<String, ModeOverride>,
}

impl SiteHealthBook {
    pub fn effective_mode(&self, site: &str) -> SiteMode {
        match self.overrides.get(site) {
            Some(ModeOverride::PreferTab) => SiteMode::Tab,
            Some(ModeOverride::PreferDedicated) => SiteMode::Dedicated,
            None => self
                .sites
                .get(site)
                .map(|h| h.mode)
                .unwrap_or(SiteMode::Tab),
        }
    }

    pub fn override_of(&self, site: &str) -> Option<ModeOverride> {
        self.overrides.get(site).copied()
    }

    pub fn set_override(&mut self, site: &str, o: Option<ModeOverride>) {
        match o {
            Some(o) => {
                self.overrides.insert(site.to_string(), o);
            }
            None => {
                self.overrides.remove(site);
            }
        }
    }

    fn state(&mut self, site: &str) -> &mut SiteHealth {
        self.sites
            .entry(site.to_string())
            .or_insert_with(SiteHealth::new)
    }

    /// 双脉冲耗尽仍无进展(前置已由调用方校验):Tab → DedicatedPending。
    /// 返回 true = 状态发生了变化(调用方记轨迹)
    pub fn note_pulse_exhausted(&mut self, site: &str) -> bool {
        let st = self.state(site);
        if st.mode == SiteMode::Tab {
            st.mode = SiteMode::DedicatedPending;
            st.last_action = "双脉冲后仍无进展,标记独立窗口".into();
            return true;
        }
        false
    }

    /// 一轮生成成功:推进 3-of-5 历史;Tab 模式下够数即升级 Pending;
    /// Dedicated 模式下无唤醒/脉冲计健康轮,有则归零(降级仅手动,健康轮仅展示)
    pub fn note_turn_success(&mut self, site: &str, used_pulse: bool) {
        let st = self.state(site);
        st.liveness_failures = 0;
        st.pulse_required_turns.push_back(used_pulse);
        while st.pulse_required_turns.len() > 5 {
            st.pulse_required_turns.pop_front();
        }
        let recent_pulses = st.pulse_required_turns.iter().filter(|x| **x).count();
        if st.mode == SiteMode::Tab && recent_pulses >= 3 {
            st.mode = SiteMode::DedicatedPending;
            st.last_action = "近 5 轮 3 轮依赖激活脉冲,标记独立窗口".into();
            return;
        }
        if st.mode == SiteMode::Dedicated {
            if used_pulse {
                st.healthy_turns = 0;
                st.last_action = "独立窗口本轮仍需激活".into();
            } else {
                st.healthy_turns = st.healthy_turns.saturating_add(1);
                st.last_action = format!("独立窗口稳定生成 {} 轮", st.healthy_turns);
            }
        }
    }

    /// 一轮以活性失败收场(仅 Stalled 类错误走到这里)
    pub fn note_turn_liveness_failure(&mut self, site: &str) {
        let st = self.state(site);
        st.liveness_failures = st.liveness_failures.saturating_add(1);
    }

    /// 升级落地(独立窗口已创建):Pending → Dedicated
    pub fn note_promoted(&mut self, site: &str, now: Instant) {
        let st = self.state(site);
        st.mode = SiteMode::Dedicated;
        st.promoted_at = Some(now);
        st.healthy_turns = 0;
        st.last_action = "已切换独立窗口".into();
    }

    /// 手动降级(设置页「重新评估该站点」):清自动升级状态回 Tab。
    /// 只重置自动判断,不动用户的显式覆盖
    pub fn re_evaluate(&mut self, site: &str) {
        let st = self.state(site);
        st.mode = SiteMode::Tab;
        st.liveness_failures = 0;
        st.pulse_required_turns.clear();
        st.healthy_turns = 0;
        st.promoted_at = None;
        st.last_action = "已重新评估,回到标签页模式".into();
    }

    /// 设置页状态快照
    pub fn status(&self, site: &str) -> SiteStatus {
        let st = self
            .sites
            .get(site)
            .cloned()
            .unwrap_or_else(SiteHealth::new);
        SiteStatus {
            site: site.to_string(),
            mode: st.mode,
            r#override: self.overrides.get(site).copied(),
            liveness_failures: st.liveness_failures,
            recent_pulses: st.pulse_required_turns.iter().filter(|x| **x).count() as u8,
            healthy_turns: st.healthy_turns,
            last_action: st.last_action,
        }
    }
}

/// 设置页每站点状态(camelCase 序列化给前端)
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SiteStatus {
    pub site: String,
    pub mode: SiteMode,
    #[serde(rename = "override")]
    pub r#override: Option<ModeOverride>,
    pub liveness_failures: u8,
    pub recent_pulses: u8,
    pub healthy_turns: u16,
    pub last_action: String,
}

// ---------- 测试 ----------

#[cfg(test)]
mod tests {
    use super::*;

    const P: ActivityPolicy = ActivityPolicy {
        first_soft_wake_ms: 6_000,
        first_pulse_ms: 15_000,
        second_soft_wake_ms: 30_000,
        second_pulse_ms: 45_000,
        promote_ms: 60_000,
        streaming_soft_wake_ms: 20_000,
        streaming_pulse_ms: 45_000,
    };

    fn snap(count: u64, text: &str, busy: bool) -> ActivitySnapshot {
        ActivitySnapshot {
            count,
            text_hash: ActivitySnapshot::text_hash(text),
            text_len: text.len(),
            busy,
            input_ready: true,
            turn_error: false,
            visibility: "visible".into(),
            focused: false,
        }
    }

    fn tracker() -> ActivityTracker {
        ActivityTracker::begin(P, Instant::now())
    }

    fn at(
        tracker: &mut ActivityTracker,
        phase: AskPhase,
        s: &ActivitySnapshot,
        ms: u64,
    ) -> Observation {
        tracker.observe(phase, s, Instant::now() + Duration::from_millis(ms))
    }

    fn action_of(o: &Observation) -> RecoveryAction {
        o.action
    }

    #[test]
    fn no_wake_before_threshold_and_ladder_fires_in_order() {
        let mut t = tracker();
        let s = snap(0, "", false);
        assert_eq!(
            action_of(&at(&mut t, AskPhase::Sent, &s, 5_999)),
            RecoveryAction::None
        );
        assert_eq!(
            action_of(&at(&mut t, AskPhase::Sent, &s, 6_000)),
            RecoveryAction::SoftWake
        );
        t.note_action(RecoveryAction::SoftWake, true, Instant::now());
        // 15s:第一次脉冲
        assert_eq!(
            action_of(&at(&mut t, AskPhase::Sent, &s, 14_999)),
            RecoveryAction::None
        );
        assert_eq!(
            action_of(&at(&mut t, AskPhase::Sent, &s, 15_000)),
            RecoveryAction::ActivationPulse
        );
        t.note_action(RecoveryAction::ActivationPulse, true, Instant::now());
        // 30s:第二次软唤醒
        assert_eq!(
            action_of(&at(&mut t, AskPhase::Sent, &s, 30_000)),
            RecoveryAction::SoftWake
        );
        t.note_action(RecoveryAction::SoftWake, true, Instant::now());
        // 45s:第二次脉冲
        assert_eq!(
            action_of(&at(&mut t, AskPhase::Sent, &s, 45_000)),
            RecoveryAction::ActivationPulse
        );
        t.note_action(RecoveryAction::ActivationPulse, true, Instant::now());
        // 45s~promote:脉冲②的确认窗内不动
        assert_eq!(
            action_of(&at(&mut t, AskPhase::Sent, &s, 59_999)),
            RecoveryAction::None
        );
        assert_eq!(
            action_of(&at(&mut t, AskPhase::Sent, &s, 60_000)),
            RecoveryAction::PromoteDedicated
        );
        // 上报一次后沉默(受总超时约束)
        assert_eq!(
            action_of(&at(&mut t, AskPhase::Sent, &s, 70_000)),
            RecoveryAction::None
        );
    }

    #[test]
    fn progress_resets_timers_and_counts_and_reports_recovery() {
        let mut t = tracker();
        let idle = snap(0, "", false);
        assert_eq!(
            action_of(&at(&mut t, AskPhase::Sent, &idle, 6_000)),
            RecoveryAction::SoftWake
        );
        t.note_action(RecoveryAction::SoftWake, true, Instant::now());
        // 出现进展:busy 由否变是 → recovered 标记,计数清零
        let o = at(&mut t, AskPhase::Sent, &snap(0, "", true), 7_000);
        assert_eq!(o.marks, vec!["activity:soft_wake_recovered"]);
        assert_eq!(o.action, RecoveryAction::None);
        // 清零后 6s 内不再唤醒;再次停滞从新基线起重新走梯子
        let o = at(&mut t, AskPhase::Sent, &snap(0, "", true), 9_000);
        assert_eq!(o.action, RecoveryAction::None);
        assert_eq!(o.idle_ms, 2_000);
        let stalled = snap(0, "", true);
        assert_eq!(
            action_of(&at(&mut t, AskPhase::Sent, &stalled, 15_000)),
            RecoveryAction::SoftWake,
            "计数清零后梯子从软唤醒重新开始"
        );
    }

    #[test]
    fn text_growth_counts_as_progress_and_restarts_ladder() {
        let mut t = tracker();
        assert_eq!(
            action_of(&at(&mut t, AskPhase::Sent, &snap(1, "部分", false), 6_500)),
            RecoveryAction::SoftWake
        );
        t.note_action(RecoveryAction::SoftWake, true, Instant::now());
        let o = at(&mut t, AskPhase::Sent, &snap(1, "部分回复", false), 7_000);
        assert!(o.marks.contains(&"activity:soft_wake_recovered"));
    }

    #[test]
    fn streaming_stall_uses_text_clock_and_repeats_pulses() {
        let mut t = tracker();
        let stalled = snap(1, "同文", true);
        // 首拍进入流式:停摆钟从此刻起算(此前无法观测文本停摆)
        assert_eq!(
            action_of(&at(&mut t, AskPhase::ResponseStarted, &stalled, 0)),
            RecoveryAction::None
        );
        assert_eq!(
            action_of(&at(&mut t, AskPhase::ResponseStarted, &stalled, 19_999)),
            RecoveryAction::None
        );
        assert_eq!(
            action_of(&at(&mut t, AskPhase::ResponseStarted, &stalled, 20_000)),
            RecoveryAction::SoftWake
        );
        t.note_action(
            RecoveryAction::SoftWake,
            true,
            Instant::now() + Duration::from_millis(20_000),
        );
        assert_eq!(
            action_of(&at(&mut t, AskPhase::ResponseStarted, &stalled, 44_999)),
            RecoveryAction::None
        );
        assert_eq!(
            action_of(&at(&mut t, AskPhase::ResponseStarted, &stalled, 45_000)),
            RecoveryAction::ActivationPulse
        );
        t.note_action(
            RecoveryAction::ActivationPulse,
            true,
            Instant::now() + Duration::from_millis(45_000),
        );
        // 仍然无文本变化:每 45s 可再脉冲(3-of-5 规则的输入)
        assert_eq!(
            action_of(&at(&mut t, AskPhase::ResponseStarted, &stalled, 89_999)),
            RecoveryAction::None
        );
        assert_eq!(
            action_of(&at(&mut t, AskPhase::ResponseStarted, &stalled, 90_000)),
            RecoveryAction::ActivationPulse
        );
        // 流式停滞绝不升级(promote 只在 WaitingForStart)
        assert_ne!(
            action_of(&at(&mut t, AskPhase::ResponseStarted, &stalled, 600_000)),
            RecoveryAction::PromoteDedicated
        );
        // 文本恢复增长 → recovered,停摆钟归零
        let o = at(
            &mut t,
            AskPhase::ResponseStarted,
            &snap(1, "同文续", true),
            90_500,
        );
        assert!(o.marks.contains(&"activity:pulse_recovered"));
        assert_eq!(
            action_of(&at(
                &mut t,
                AskPhase::ResponseStarted,
                &snap(2, "同文续新", true),
                95_000
            )),
            RecoveryAction::None
        );
    }

    #[test]
    fn progress_requires_real_change_not_visibility() {
        // focused/visibility 变化不算进展;count/text/busy 才算
        let mut t = tracker();
        let mut hidden = snap(0, "", false);
        hidden.visibility = "hidden".into();
        assert_eq!(
            action_of(&at(&mut t, AskPhase::Sent, &hidden, 1_000)),
            RecoveryAction::None
        );
        let mut focus = hidden.clone();
        focus.focused = true;
        let o = at(&mut t, AskPhase::Sent, &focus, 2_000);
        assert_eq!(o.action, RecoveryAction::None);
        assert!(o.marks.is_empty());
    }

    #[test]
    fn suppressed_promotion_stays_silent() {
        let mut t = tracker();
        let s = snap(0, "", false);
        // 先走完双脉冲,60s 确认窗后才到升级判定点
        assert_eq!(
            action_of(&at(&mut t, AskPhase::Sent, &s, 15_000)),
            RecoveryAction::ActivationPulse
        );
        t.note_action(
            RecoveryAction::ActivationPulse,
            true,
            Instant::now() + Duration::from_millis(15_000),
        );
        assert_eq!(
            action_of(&at(&mut t, AskPhase::Sent, &s, 45_000)),
            RecoveryAction::ActivationPulse
        );
        t.note_action(
            RecoveryAction::ActivationPulse,
            true,
            Instant::now() + Duration::from_millis(45_000),
        );
        assert_eq!(
            action_of(&at(&mut t, AskPhase::Sent, &s, 60_000)),
            RecoveryAction::PromoteDedicated
        );
        t.suppress_promotion();
        assert_eq!(
            action_of(&at(&mut t, AskPhase::Sent, &s, 120_000)),
            RecoveryAction::None
        );
    }

    #[test]
    fn skipped_actions_do_not_count() {
        let mut t = tracker();
        let s = snap(0, "", false);
        // 6s 请求软唤醒但被否决(如 PageSession 不可用):不计数
        assert_eq!(
            action_of(&at(&mut t, AskPhase::Sent, &s, 6_000)),
            RecoveryAction::SoftWake
        );
        t.note_action(RecoveryAction::SoftWake, false, Instant::now());
        // 下一拍继续请求(而非跳到 15s 脉冲)
        assert_eq!(
            action_of(&at(&mut t, AskPhase::Sent, &s, 6_300)),
            RecoveryAction::SoftWake
        );
    }

    #[test]
    fn pulse_coordinator_throttles_globally_and_per_target() {
        let mut c = PulseCoordinator::new();
        let t0 = Instant::now();
        assert!(c.try_acquire("A", t0));
        assert!(
            !c.try_acquire("B", t0 + Duration::from_millis(500)),
            "全局 1.5s 内拒绝"
        );
        assert!(
            c.try_acquire("B", t0 + Duration::from_millis(1_600)),
            "不同目标 1.5s 后放行"
        );
        assert!(
            !c.try_acquire("B", t0 + Duration::from_millis(2_000)),
            "同目标 10s 内拒绝"
        );
        assert!(
            c.try_acquire("B", t0 + Duration::from_millis(11_700)),
            "同目标 10s 后放行"
        );
    }

    #[test]
    fn site_health_promotes_on_double_pulse_and_three_of_five() {
        let mut book = SiteHealthBook::default();
        assert_eq!(book.effective_mode("deepseek"), SiteMode::Tab);
        assert!(book.note_pulse_exhausted("deepseek"));
        assert_eq!(book.effective_mode("deepseek"), SiteMode::DedicatedPending);
        assert!(!book.note_pulse_exhausted("deepseek"), "重复标记幂等");
        // 其他站点不受影响
        assert_eq!(book.effective_mode("doubao"), SiteMode::Tab);
        // 升级落地
        book.note_promoted("deepseek", Instant::now());
        assert_eq!(book.effective_mode("deepseek"), SiteMode::Dedicated);
        // 手动降级
        book.re_evaluate("deepseek");
        assert_eq!(book.effective_mode("deepseek"), SiteMode::Tab);

        // 3-of-5:近 5 轮 3 轮依赖脉冲 → Pending
        let mut book = SiteHealthBook::default();
        book.note_turn_success("chatgpt", true);
        book.note_turn_success("chatgpt", false);
        book.note_turn_success("chatgpt", true);
        assert_eq!(book.effective_mode("chatgpt"), SiteMode::Tab);
        book.note_turn_success("chatgpt", true);
        assert_eq!(book.effective_mode("chatgpt"), SiteMode::DedicatedPending);
        // 成功清零活性失败计数
        book.note_turn_liveness_failure("chatgpt");
        book.note_turn_liveness_failure("chatgpt");
        book.note_turn_success("chatgpt", false);
        let st = book.status("chatgpt");
        assert_eq!(st.liveness_failures, 0, "成功轮清零失败计数");
        assert_eq!(st.recent_pulses, 3);
    }

    #[test]
    fn override_overrides_automatic_mode() {
        let mut book = SiteHealthBook::default();
        book.note_pulse_exhausted("deepseek");
        book.set_override("deepseek", Some(ModeOverride::PreferTab));
        assert_eq!(
            book.effective_mode("deepseek"),
            SiteMode::Tab,
            "用户强制标签页压制自动升级"
        );
        book.set_override("deepseek", Some(ModeOverride::PreferDedicated));
        assert_eq!(book.effective_mode("deepseek"), SiteMode::Dedicated);
        book.set_override("deepseek", None);
        assert_eq!(book.effective_mode("deepseek"), SiteMode::DedicatedPending);
        // re_evaluate 只清自动状态,不动显式覆盖
        book.set_override("deepseek", Some(ModeOverride::PreferDedicated));
        book.re_evaluate("deepseek");
        assert_eq!(book.effective_mode("deepseek"), SiteMode::Dedicated);
    }

    #[test]
    fn observation_carries_diagnostics() {
        let mut t = tracker();
        let o = at(&mut t, AskPhase::Sent, &snap(0, "", false), 6_000);
        assert_eq!(o.idle_ms, 6_000);
        assert_eq!(o.wake_attempt, 0);
        t.note_action(
            RecoveryAction::SoftWake,
            true,
            Instant::now() + Duration::from_millis(6_000),
        );
        let o = at(&mut t, AskPhase::Sent, &snap(0, "", false), 6_300);
        assert_eq!(o.wake_attempt, 1);
    }
}
