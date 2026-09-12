// 工具栏 Dock 的布局常量:面板/菜单锚点、按钮尺寸统一从这里取,
// 避免 top+46 / +25px 这类魔法数字散落在 App.tsx、ControlBar 与各面板组件里。

/** Dock 外壳高度(px) */
export const DOCK_HEIGHT = 44
/** 面板锚点:Dock 底部留 6px 呼吸后再放面板(聊天/话题/命令/翻译/抉择共用) */
export const PANEL_ANCHOR = DOCK_HEIGHT + 6
/** 模式菜单左缘相对锚点的偏移:把手(38) + 间距(6),菜单对齐 ModePicker 正下方 */
export const MENU_LEFT_OFFSET = 38 + 6
/** 主按钮最小宽度:开始一段/取消生成/停止演出/下播 切换时不横跳 */
export const PRIMARY_MIN_WIDTH = 92
