# Morrow 全局界面改版

版本：0.4.2-unified-workspace。

本次把已有聊天工作区的暖白、薄荷绿、深绿正文和圆角卡片扩展到应用其他页面。沿用 React、Ant Design 和现有图标，不增加 UI 依赖。

## 页面安排

| 页面 | 改版内容 | 交互方式 |
| --- | --- | --- |
| 陪伴 | 日常问候、频率、气泡显示、专注时间四组卡片 | 修改立即保存，安静时间可以提前结束 |
| 外观 | 桌面展示、动作表现、鼠标与窗口 | 大小数值、范围刻度、原生开关和选择器 |
| 角色与动作 | 角色库、表情画廊、动作舞台 | 表情缩略图、动态加载动作数量和标签、停止恢复待机 |
| 模型连接 | 服务连接、回复与思考、上下文与等待、记忆与主动陪伴 | 显式保存，所有原配置字段保留，保存本身不调用模型 |
| 记忆 | 新增卡片、已保存列表、状态、管理入口 | 保存后进入下一次对话，后台可修订和查看出处 |
| 独立后台 | 七个页面共用浅色侧栏、标题、筛选卡片、表格、统计卡片 | 保留按会话筛选、模糊搜索、编辑、抽屉、导出和删除确认 |

顶部分类导航在聊天和设置间保持一致。设置页左侧展示当前角色及状态，并提供聊天与后台入口；主区域独立滚动，切换页面回到页首。找回角色、收起和退出保留在底部。

宽窗口使用双列卡片；小于 900px 时设置卡片改为单列；小于 650px 时角色侧栏缩为顶栏。后台保持 Ant Design 的标准桌面管理布局，窄窗口收起导航，宽表格在表格内部滚动。

## 代码位置

- `src/renderer/src/main.tsx`：统一导航、设置布局、通用 SettingsCard。
- `src/renderer/src/settings-workspace.css`：设置页视觉与响应式布局，仅影响设置页。
- `src/renderer/src/ChatPanel.tsx` 与 `chat-workspace.css`：模型与记忆分组，同时保留已有聊天布局。
- `src/renderer/src/admin/AdminApp.tsx` 与 `admin.css`：Ant Design 主题、品牌、页面标题、表格和统计样式。
- `scripts/verify-workspace.mjs`：逐页功能与窗口尺寸检查、实际应用截图。

透明角色窗口、动画算法、角色包主题、模型协议、记忆规则及 SQLite 表结构沿用现有实现。另修复连续表情切换时旧图片解码被取消却误报动作失败的问题：取消后的旧帧不再触发恢复默认表情，当前帧真正损坏仍正常报错。浏览设置或后台不会触发新增模型调用。

## 验证与运行

```powershell
npm run build
npm test
npm run verify:workspace
npm run verify:chat
npm run verify:admin
```

验收全部使用 `data/tests/` 的独立数据。工作区验收不配置可用云端连接；聊天和后台回归使用本地模拟模型。不会打开或修改 `data/local` 中的真实聊天、记忆和密钥。

宽窄窗口截图保存到 `artifacts/screenshots/全局新版-*`，报告为 `artifacts/reports/workspace-source-check.json` 和 `workspace-packaged-check.json`。报告记录真实通过结果；截图为合成测试数据，不代表用户现有记录。

关闭旧版本后，双击 `scripts/start-workspace.cmd` 启动 `release/0.4.2-unified-workspace/win-unpacked/Morrow.exe`。启动器继续使用项目 `data/local`，旧运行包保留。

打包版验收：先将 `MORROW_EXECUTABLE_PATH` 设置为新版程序的绝对路径，再运行 `node scripts/verify-workspace.mjs --packaged`；聊天和后台验收支持同样的参数。
