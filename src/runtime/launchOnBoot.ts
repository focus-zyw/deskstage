// 开机自启动:把系统注册状态对齐到配置值。配置是唯一事实来源——
// 面板开关与手改配置文件两条路都汇到这里;启动时对账一次,改了配置文件重启也能生效。
// 浏览器预览(无 Tauri 运行时)跳过
import { enable as autoStartEnable, disable as autoStartDisable, isEnabled as isAutoStartEnabled } from '@tauri-apps/plugin-autostart'
import { inTauri } from '../storage/configStore'

export async function applyLaunchOnBoot(want: boolean): Promise<void> {
  if (!inTauri) return
  try {
    if ((await isAutoStartEnabled()) !== want) {
      await (want ? autoStartEnable() : autoStartDisable())
    }
  } catch (e) {
    console.warn('开机自启动设置失败', e)
  }
}
