# 四糸乃动作、表情与过渡素材 v2

日期：2026-10-03。状态：已制作 9 张素材与独立预览，并接入 0.2.0-companion 桌宠运行时；素材仍标记 draft，等待审美反馈。仅补充同一人物，不新增正式角色。原有素材保留。

使用内置 imagegen，以原有四糸乃为身份基准，不使用 CLI 或用户 API Key。完整提示词见 [generation-prompts-v2.md](generation-prompts-v2.md)，工具原始输出备份在 `v2原始输出/`。

## 本批交付

路径相对 `characters/yoshino/`。

| 图片 | 路径 | 用途 |
| --- | --- | --- |
| normal | assets/portraits/v2/normal.png | 新版基准，延续原有衣装与姿态，检查透明背景 |
| happy | assets/expressions/v2/happy.png | 温柔微笑，保持站姿 |
| shy | assets/expressions/v2/shy.png | 害羞与轻微脸红，保持站姿 |
| blink-half | assets/animations/frames/v2/blink-half.png | 半闭眼中间帧 |
| blink-closed | assets/animations/frames/v2/blink-closed.png | 闭眼帧 |
| greet-mid | assets/animations/frames/v2/greet-mid.png | 抬手途中 |
| greet-peak | assets/animations/frames/v2/greet-peak.png | 右手抬起的温柔问候 |
| shy-mid | assets/animations/frames/v2/shy-mid.png | 轻微低头途中 |
| shy-peak | assets/animations/frames/v2/shy-peak.png | 害羞低头姿态 |

全套为 1024×1536 RGBA PNG。保持绿色兔耳灵装、蓝发、人物比例和脚部位置；四糸奈仍在人物自身左手（画面右侧），不镜像。问候调整空着的右手与相应袖口；低头调整头部与周围的兜帽、发丝。

## 过渡预览

原项目曾提供四糸乃动作过渡预览-v2.html（历史预览页面未纳入此核心仓库）。当时页面包含：

- 平常、开心、害羞表情，约 180 毫秒的短交叠。
- 眨眼：睁眼 → 半闭 → 闭眼 → 半闭 → 睁眼。
- 问候：平常 → 抬手途中 → 问候 → 抬手途中 → 平常。
- 害羞低头：平常 → 低头途中 → 低头 → 低头途中 → 平常。
- 可调速度、自动眨眼、浅色/深色/棋盘背景和停止恢复；新操作取消旧动作。
- 遵循系统减少动态效果，页面隐藏时停止播放。

中间帧与短交叠能减轻硬切。它们是少量关键姿态，并非骨骼动画或高帧率逐帧动画；手臂大幅移动的短交叠仍可能看到局部重影，服装细节也有轻微生成差异。更高要求可以继续补充相邻帧或准备分层素材，不声称逐像素一致。

原帧动作顺序与时间保存在 `assets/animations/sequences-v2.json`。0.2.1 修复眨眼闪烁：保留基准身体，只在配置的两个眼部椭圆蒙版内切换半闭/闭眼帧。0.2.2 新增 `assets/animations/motions-v3.json`，通过 manifest.visual.motionConfig 接入；问候、害羞和安慰改用同一张表情图的连续局部网格形变，下部保持固定。当前问候是小幅手部回应，大幅抬手帧保留作参考，不宣称已做成大幅连续挥手。表情切换采用互补透明度与 plus-lighter 混合。取消、隐藏和切换角色会打断旧演出；说话动作结束直接停在相应表情。旧 HTML 预览仍使用完整姿态图，查看当前效果请启动桌宠。

## 实际检查

1. 9 张图片尺寸与 RGBA、真实透明区域检查通过，脚部区域质心与基准最大相差约 0.511 像素。这是位置一致性的辅助指标，不是全部画面一致性的证明。
2. 已逐张查看生成结果，并在浏览器检查棋盘与深色背景。没有用处理脚本裁切、重绘或合成角色图片。
3. 浏览器实际检查通过：9 图解码、三表情切换、三组动作经过中间帧及回程、连续打断、停止恢复、减少动态效果；无页面运行错误。
4. 减少动态效果的首次自动检查等待时序失败；已单独检查功能正常，调整验收顺序后完整检查通过。不将第一次失败隐藏为通过。

报告：`artifacts/reports/素材-v2-assets-check.json`、`素材-v2-preview-check.json`。截图：`artifacts/screenshots/四糸乃动作过渡预览-v2.png`、`四糸乃表情深色预览-v2.png`。

运行时已接入启动问候、悬停、点击、拖动落定与低频主动文字，使用角色包中的原创固定短句；尚未接入自由聊天。运行时结果见 `artifacts/reports/M1-陪伴互动.md`。语音继续暂缓，语音文件夹为空。

0.2.3 在上述基础上新增双关节大幅挥手，使用 v4 补全底图、上臂与前臂，旧完整姿态图仍保留；新增左右看看和四糸奈局部回应。0.2.4 已按用户反馈移除轻鞠躬，其余动作观感已获确认。当前挥手效果请启动桌宠，制作规范与提示词见 [rig-assets-v4.md](rig-assets-v4.md)。
