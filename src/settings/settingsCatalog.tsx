// 设置窗口的静态目录:分页导航(图标/分组)与搜索索引。
// 纯数据,无行为;SettingsWindow 消费,搜索索引按"label 卡片 关键词"匹配。
import type { ReactElement } from 'react'

export type SettingsTab =
  | 'general'
  | 'model'
  | 'persona'
  | 'modes'
  | 'topics'
  | 'bubble'
  | 'voice'
  | 'live'
  | 'hotkeys'
  | 'privacy'
  | 'memory'
  | 'memo'
  | 'favorites'
  | 'history'
  | 'chatlog'
  | 'dev'
  | 'support'

/** 左侧导航:偏好设置 / 数据管理 两组 */
export const SETTINGS_NAV: { group: string; items: { id: SettingsTab; label: string; icon: ReactElement }[] }[] = [
  {
    group: '偏好设置',
    items: [
      {
        id: 'general',
        label: '基础设置',
        icon: (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <line x1="4" y1="21" x2="4" y2="14" />
            <line x1="4" y1="10" x2="4" y2="3" />
            <line x1="12" y1="21" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12" y2="3" />
            <line x1="20" y1="21" x2="20" y2="16" />
            <line x1="20" y1="12" x2="20" y2="3" />
            <line x1="1" y1="14" x2="7" y2="14" />
            <line x1="9" y1="8" x2="15" y2="8" />
            <line x1="17" y1="16" x2="23" y2="16" />
          </svg>
        ),
      },
      {
        id: 'model',
        label: 'AI 模型',
        icon: (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="5" y="5" width="14" height="14" rx="2" />
            <rect x="9.5" y="9.5" width="5" height="5" />
            <line x1="9" y1="2" x2="9" y2="5" />
            <line x1="15" y1="2" x2="15" y2="5" />
            <line x1="9" y1="19" x2="9" y2="22" />
            <line x1="15" y1="19" x2="15" y2="22" />
            <line x1="19" y1="9" x2="22" y2="9" />
            <line x1="19" y1="15" x2="22" y2="15" />
            <line x1="2" y1="9" x2="5" y2="9" />
            <line x1="2" y1="15" x2="5" y2="15" />
          </svg>
        ),
      },
      {
        id: 'persona',
        label: '角色人设',
        icon: (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        ),
      },
      {
        id: 'modes',
        label: '模式工坊',
        icon: (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
            <line x1="19" y1="17" x2="19" y2="21" />
            <line x1="17" y1="19" x2="21" y2="19" />
          </svg>
        ),
      },
      {
        id: 'topics',
        label: '演出话题',
        icon: (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            <line x1="9" y1="7" x2="17" y2="7" />
            <line x1="9" y1="11" x2="15" y2="11" />
          </svg>
        ),
      },
      {
        id: 'bubble',
        label: '气泡工坊',
        icon: (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
        ),
      },
      {
        id: 'voice',
        label: '角色语音',
        icon: (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
            <path d="M19 11v1a7 7 0 0 1-14 0v-1" />
            <line x1="12" y1="19" x2="12" y2="22" />
          </svg>
        ),
      },
      {
        id: 'live',
        label: '直播设置',
        icon: (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <circle cx="12" cy="12" r="2" />
            <path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.25a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14" />
          </svg>
        ),
      },
      {
        id: 'hotkeys',
        label: '快捷键',
        icon: (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="5" width="20" height="14" rx="2" />
            <line x1="6" y1="9" x2="6" y2="9" />
            <line x1="10" y1="9" x2="10" y2="9" />
            <line x1="14" y1="9" x2="14" y2="9" />
            <line x1="18" y1="9" x2="18" y2="9" />
            <line x1="7" y1="15" x2="17" y2="15" />
          </svg>
        ),
      },
      {
        id: 'privacy',
        label: '工具与隐私',
        icon: (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
        ),
      },
    ],
  },
  {
    group: '数据管理',
    items: [
      {
        id: 'memory',
        label: '记忆',
        icon: (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
        ),
      },
      {
        id: 'memo',
        label: '备忘',
        icon: (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 11 12 14 22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
        ),
      },
      {
        id: 'favorites',
        label: '收藏',
        icon: (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
        ),
      },
      {
        id: 'history',
        label: '历史',
        icon: (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        ),
      },
      {
        id: 'chatlog',
        label: '聊天记录',
        icon: (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            <line x1="8" y1="9" x2="16" y2="9" />
            <line x1="8" y1="13" x2="13" y2="13" />
          </svg>
        ),
      },
      {
        id: 'dev',
        label: '链路诊断',
        icon: (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
        ),
      },
    ],
  },
  {
    group: '支持',
    items: [
      {
        id: 'support',
        label: '支持作者',
        icon: (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
          </svg>
        ),
      },
    ],
  },
]

/** 分页 → 所属分组(标题栏眉标与搜索结果面包屑用) */
export const TAB_GROUP: Record<SettingsTab, string> = {
  general: '偏好设置',
  model: '偏好设置',
  persona: '偏好设置',
  modes: '偏好设置',
  topics: '偏好设置',
  bubble: '偏好设置',
  voice: '偏好设置',
  live: '偏好设置',
  hotkeys: '偏好设置',
  privacy: '偏好设置',
  memory: '数据管理',
  memo: '数据管理',
  favorites: '数据管理',
  history: '数据管理',
  chatlog: '数据管理',
  dev: '数据管理',
  support: '支持',
}

/** 搜索索引:每个可搜索的设置项 → 所在分页 + 卡片(点击结果跳转并高亮卡片) */
export const SETTINGS_SEARCH_INDEX: { tab: SettingsTab; card: string; label: string; keywords?: string }[] = [
  // 基础设置
  { tab: 'general', card: '显示与布局', label: '界面主题', keywords: '主题 深色 浅色 外观 配色 light dark' },
  { tab: 'general', card: '显示与布局', label: '显示角色', keywords: '隐藏 角色 立绘 桌面' },
  { tab: 'general', card: '显示与布局', label: '显示常驻角色C', keywords: '小管家 视频 webm 第三角色 常驻 隐藏' },
  { tab: 'general', card: '显示与布局', label: '恢复C的位置', keywords: '位置 重置 常驻 小管家' },
  { tab: 'general', card: '显示与布局', label: '恢复默认布局', keywords: '位置 缩放 重置 拖动' },
  { tab: 'general', card: '演出与主动行为', label: '空闲自动重放', keywords: '重放 历史 自动 分钟' },
  { tab: 'general', card: '演出与主动行为', label: '主动程度', keywords: '频率 安静 平衡 热闹 闲聊' },
  { tab: 'general', card: '演出与主动行为', label: '久坐提醒', keywords: '休息 番茄 健康 分钟' },
  { tab: 'general', card: '演出与主动行为', label: '观众抉择点概率', keywords: 'choice 抉择 选择 互动 站队 概率 频率' },
  { tab: 'general', card: '演出与主动行为', label: '互动台词每日一换', keywords: '台词包 每日 换新 互动 戳 摸头 投喂 点播 小管家 角色C' },
  { tab: 'general', card: '环境与桌面', label: '桌面环境感知', keywords: '电量 应用 感知 分类 前台' },
  { tab: 'general', card: '环境与桌面', label: '感知注入冷却', keywords: '冷却 频率 分钟 注入 环境 重复' },
  { tab: 'general', card: '环境与桌面', label: '显示左上角水印', keywords: '水印 直播 录屏' },
  { tab: 'general', card: '环境与桌面', label: '开机自启动', keywords: '自启 开机 启动 登录 autostart' },
  // AI 模型
  { tab: 'model', card: '主模型', label: '厂商', keywords: 'deepseek 智谱 ollama 供应商' },
  { tab: 'model', card: '主模型', label: 'API Key', keywords: '密钥 鉴权 token' },
  { tab: 'model', card: '主模型', label: '接口地址', keywords: 'baseUrl 端点 地址' },
  { tab: 'model', card: '主模型', label: '模型', keywords: 'deepseek-chat 模型名' },
  { tab: 'model', card: '提取文字', label: 'OCR API Key', keywords: '视觉 识别 截图 文字 免费' },
  { tab: 'model', card: '提取文字', label: 'OCR 接口地址', keywords: '视觉 识别 地址' },
  { tab: 'model', card: '提取文字', label: 'OCR 视觉模型', keywords: 'glm 视觉 识别' },
  { tab: 'model', card: '提取文字', label: '识别引擎', keywords: '本地 ai 自动 熔断 回退 引擎' },
  // 群聊角色绑定与模型档案(自由群聊)
  { tab: 'model', card: '群聊角色绑定', label: '群聊角色的模型绑定', keywords: '自由群聊 多角色 绑定 模型 档案 网页 接话 旁听 活跃度 自主' },
  { tab: 'model', card: '群聊角色绑定', label: '甲乙丙各自的模型', keywords: '甲 乙 丙 A B C 角色 模型 网页站点 登录' },
  { tab: 'model', card: '群聊角色绑定', label: '角色的活跃度档位', keywords: '安静 平衡 热闹 活跃 自主 频率 接话' },
  { tab: 'model', card: '模型档案', label: '新增/编辑模型档案', keywords: '模型档案 api 端点 多模型 profile 厂商 地址 密钥 群聊' },
  // 基础设置
  { tab: 'general', card: '显示与布局', label: '气泡风格', keywords: '气泡 柔彩 夜色 玻璃 主题 外观 配色' },
  // 气泡工坊
  { tab: 'bubble', card: '选择主题', label: '气泡风格切换', keywords: '气泡 主题 柔彩 夜色 玻璃 切换 外观 复制' },
  { tab: 'bubble', card: 'AI 生成主题', label: 'AI 生成气泡主题', keywords: '气泡 自定义 生成 三方案 候选 配色 工坊' },
  { tab: 'bubble', card: '编辑主题', label: '气泡主题编辑', keywords: '气泡 模板 材质 主色 派生 覆盖 对比度 修复 撤销 重做 字体 字号 圆角 描边 阴影 辉光 纹理 尾巴 名签 预览 编辑' },
  { tab: 'bubble', card: '预览', label: '气泡多场景预览', keywords: '气泡 预览 长文本 喊话 翻转 深色 浅色 透明桌面 对比 诊断' },
  // 角色人设
  { tab: 'persona', card: '角色名字', label: '角色A的名字', keywords: '名字 称呼 名牌' },
  { tab: 'persona', card: '角色名字', label: '角色B的名字', keywords: '名字 称呼 名牌' },
  { tab: 'persona', card: '角色名字', label: '角色C的名字', keywords: '名字 称呼 名牌 小管家' },
  { tab: 'persona', card: '角色人设', label: '角色A的人设', keywords: '人设 性格 职业 背景' },
  { tab: 'persona', card: '角色人设', label: '角色B的人设', keywords: '人设 性格 职业 背景' },
  { tab: 'persona', card: '角色人设', label: '角色C的人设', keywords: '人设 性格 小管家 字面 执行' },
  { tab: 'persona', card: '角色人设', label: '还原默认人设', keywords: '重置 出厂 内置' },
  // 模式工坊
  { tab: 'modes', card: 'AI 创建模式', label: 'AI 创建模式', keywords: '自定义 新模式 玩法 点播 生成 模式工坊' },
  { tab: 'topics', card: '默认点播方式', label: '默认持续时间/联想距离/严格围绕', keywords: '演出话题 本次 默认 持续 时间 联想 距离 严格 围绕 点播' },
  { tab: 'topics', card: '自动选题来源', label: '自动选题来源(兴趣/角色故事/AI 扩充)', keywords: '演出话题 来源 兴趣 角色故事 往事 AI 扩充 发现 环境' },
  { tab: 'topics', card: '个人类话题', label: '个人类话题自动策略', keywords: '演出话题 个人 敏感 健康 失落 隐私 主动' },
  { tab: 'topics', card: '话题口味', label: '清除话题口味记录', keywords: '话题 口味 喜欢 不喜欢 收藏 清除 重置 学习' },
  { tab: 'topics', card: '角色适配', label: '角色适配说明', keywords: '话题 角色 适配 人设 职业 C 小管家' },
  { tab: 'modes', card: '编辑模式', label: '模式草稿编辑', keywords: '编辑 修改 模式 触发词 兜底剧本' },
  { tab: 'modes', card: '自定义模式', label: '自定义模式列表', keywords: '自定义 删除 模式 列表' },
  { tab: 'modes', card: '内置模式', label: '内置模式', keywords: '内置 相声 日常 主播 模式' },
  // 角色语音
  { tab: 'voice', card: '语音与供应商', label: '角色语音开关', keywords: '朗读 配音 开关' },
  { tab: 'voice', card: '语音与供应商', label: '语音供应商', keywords: '硅基流动 minimax cosyvoice gpt-sovits sovits 本地' },
  { tab: 'voice', card: '语音与供应商', label: '语音 API Key', keywords: 'siliconflow 密钥' },
  { tab: 'voice', card: '语音与供应商', label: 'MiniMax API Key', keywords: 'minimax 密钥' },
  { tab: 'voice', card: '语音与供应商', label: 'MiniMax GroupId', keywords: 'minimax 分组' },
  { tab: 'voice', card: '语音与供应商', label: 'MiniMax 模型', keywords: 'turbo hd 高质' },
  { tab: 'voice', card: '语音与供应商', label: 'GPT-SoVITS 服务地址', keywords: 'sovits 本地 自建 9880 api_v2 地址' },
  { tab: 'voice', card: '语音与供应商', label: 'GPT-SoVITS 流式档位', keywords: 'sovits 流式 首包 延迟 档位' },
  { tab: 'voice', card: '语音与供应商', label: 'GPT-SoVITS 台词语言', keywords: 'sovits text_lang 语言 自动检测' },
  { tab: 'voice', card: 'GPT-SoVITS 参考音色', label: '参考音色表', keywords: 'sovits 参考音频 音色 参考文本 克隆 本地' },
  { tab: 'voice', card: '语音对话', label: '对话模式', keywords: '语音对话 实时 麦克风 按键说话 免按键 听 说 asr whisper 识别' },
  { tab: 'voice', card: '语音对话', label: '麦克风测试', keywords: '麦克风 设备 电平 测试 校准 底噪 阈值' },
  { tab: 'voice', card: '语音对话', label: '识别模型与密钥', keywords: 'asr 识别 api key sensevoice 转写 测试连接' },
  { tab: 'voice', card: '语音对话', label: '说话时允许语音打断', keywords: '打断 抢话 barge 实验 外放 回声' },
  { tab: 'voice', card: '音色与表现', label: '情感指令', keywords: '情感 语气 情绪' },
  { tab: 'voice', card: '音色与表现', label: '角色甲音色', keywords: '声音 音色 分配' },
  { tab: 'voice', card: '音色与表现', label: '角色乙音色', keywords: '声音 音色 分配' },
  { tab: 'voice', card: '音色与表现', label: '角色C音色', keywords: '第三人 画外音 常驻 小管家' },
  { tab: 'voice', card: '音色与表现', label: '克隆音色', keywords: '克隆 录音 样本' },
  { tab: 'voice', card: '音色与表现', label: '试听', keywords: '预览 试听' },
  // 直播设置
  { tab: 'live', card: '直播间', label: '直播平台', keywords: 'bilibili B站 抖音' },
  { tab: 'live', card: '直播间', label: '直播间号', keywords: '房间号 开播 弹幕' },
  { tab: 'live', card: 'B站登录', label: 'B站 Cookie', keywords: 'sessdata 登录 凭证 舰长 打码' },
  { tab: 'live', card: 'B站登录', label: '扫码登录B站', keywords: '二维码 扫码 登录' },
  // 快捷键
  { tab: 'hotkeys', card: '演出控制', label: '生成快捷键', keywords: '快捷键 热键 生成 点播 播放 演出' },
  { tab: 'hotkeys', card: '演出控制', label: '停止快捷键', keywords: '快捷键 热键 停止 停下 打断' },
  { tab: 'hotkeys', card: '演出控制', label: '随机播放历史快捷键', keywords: '快捷键 热键 随机 回放 历史 重播' },
  { tab: 'hotkeys', card: '演出控制', label: '隐藏角色快捷键', keywords: '快捷键 热键 隐藏 显示 角色 立绘' },
  { tab: 'hotkeys', card: '截屏', label: '全局截屏快捷键', keywords: '截图 快捷键 热键 框选' },
  // 工具与隐私
  { tab: 'privacy', card: '截屏', label: '截屏/录屏时排除角色', keywords: '隐私 排除 录屏 隐藏' },
  { tab: 'privacy', card: '网页版生成', label: '主演出改用网页模型生成', keywords: '实验 网页 deepseek 豆包 chatgpt gemini 千问 通义' },
  { tab: 'privacy', card: '网页版生成', label: '网页模型站点', keywords: 'deepseek 豆包 chatgpt gemini 千问 通义 站点' },
  { tab: 'privacy', card: '网页版生成', label: '网页窗口登录', keywords: 'edge 登录 窗口' },
  { tab: 'privacy', card: '上下文生命周期', label: '经历记忆嵌入来源', keywords: '经历记忆 嵌入 embedding 本地 llama.cpp llama-server gguf 向量 记忆 托管 自动启动' },
  { tab: 'privacy', card: '隐私与数据', label: '隐私与数据说明', keywords: '本机 上传 隐私 安全' },
  // 记忆
  { tab: 'memory', card: '使用者画像', label: '你的称呼', keywords: '画像 称呼 名字' },
  { tab: 'memory', card: '使用者画像', label: '职业/身份', keywords: '画像 职业 身份' },
  { tab: 'memory', card: '使用者画像', label: '喜欢/不喜欢', keywords: '画像 喜好 偏好' },
  { tab: 'memory', card: '使用者画像', label: '雷区', keywords: '禁聊 话题 避免' },
  { tab: 'memory', card: '记住的事', label: '记住的事', keywords: '事实 置顶 遗忘 清空' },
  { tab: 'memory', card: '角色世界', label: '角色世界', keywords: '老梗 事件线 共同记忆' },
  { tab: 'memory', card: '连续剧情', label: '连续剧情', keywords: '剧情线 多集 下一拍' },
  // 备忘
  { tab: 'memo', card: '添加备忘', label: '添加备忘', keywords: '待办 提醒 截止时间' },
  { tab: 'memo', card: '备忘列表', label: '备忘列表', keywords: '已完成 清除 待办' },
  // 收藏
  { tab: 'favorites', card: '收藏的对话', label: '收藏的对话', keywords: '收藏 星标 精选 管理 重放 取消' },
  // 历史
  { tab: 'history', card: '演出历史', label: '演出历史', keywords: '回放 收藏 删除 历史' },
  // 聊天记录
  { tab: 'chatlog', card: '聊天记录', label: '聊天记录', keywords: '聊天 记录 对话 消息 回放 翻看 历史 微信 气泡' },
  // 链路诊断(开发)
  { tab: 'dev', card: '链路诊断', label: '链路诊断', keywords: '诊断 调试 dev 开发 回放 首token 延迟 tts llm 网页回退 cdp 排错 日志' },
  { tab: 'dev', card: '详情捕获', label: '详情捕获', keywords: '诊断 详情 脱敏 隐私 捕获 十分钟 临时' },
  { tab: 'dev', card: '诊断数据', label: '导出与清空', keywords: '诊断 导出 清空 诊断包' },
  // 支持作者
  { tab: 'support', card: '请作者喝杯奶茶', label: '支持作者', keywords: '支持 捐赠 打赏 赞助 收款码 微信 支付宝 抽奖' },
  { tab: 'support', card: '心意扭蛋机', label: '心意扭蛋机', keywords: '抽奖 扭蛋 单抽 十连 次数 保底 稀有' },
  { tab: 'support', card: '心意图鉴', label: '心意图鉴', keywords: '图鉴 收集 感谢语 稀有度 彩蛋 集齐' },
]
