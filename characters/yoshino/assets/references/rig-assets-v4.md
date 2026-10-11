# 四糸乃分层动作素材 v4

日期：2026-10-03。来源：内置 imagegen，参考本项目 v2/normal.png。AI 同人设计初稿，非官方原画；原 PNG 保留，没有使用 Python 裁切、重绘或合成角色素材。生成原图从 Codex generated_images 复制到本角色的 `assets/animations/layers/v4/`。

| 文件 | 用途 |
| --- | --- |
| body-clean.png | 补全自由手臂后面的头发、披风和连衣裙；程序只取局部补全区域 |
| upper-sleeve.png | 肩膀至肘部的独立绿色袖子 |
| forearm-open.png | 带袖口和张开五指的独立前臂 |

三份 PNG 都是 1024×1536 RGBA，四角 alpha 为 0。生成手臂的实际尺寸比提示坐标大，程序按 sourceRect、sourcePivot 和 scale 配准，不改动 PNG。生成图的隐藏 RGB 看起来可能有背景渐变，实际透明区域以 alpha 为准。手臂 sourceRect 限制取样区域，避免把画布中极低 alpha 的杂点带进演出。

`assets/animations/rig-v4.json` 声明补全区域、两节骨骼、父子层级和挥手曲线。空着的人物右手位于画面左侧，四糸奈仍在人物左手、画面右侧，不镜像。身体继续显示原表情 PNG，只剪掉需要补全的局部；画布只显示补全区域和活动手臂。肩膀为父节点、肘部为子节点；开头与末尾角度和混合比例均归零。挥手 2550ms，包含抬起、两次往复和放下；短气泡按实际剩余时间缩短完整动作，保留回程。

补充动作在 motions-v3.json：lookaround 2350ms、puppet 2050ms；轻鞠躬已在 0.2.4 按用户反馈移除。它们继续使用同图局部网格形变；手偶回应为原图局部运动，未制作独立手偶图层或口型。

## 最终提示词

以下三次均使用 referenced_image_paths 指向 v2/normal.png，transparent_background=true，使用内置工具，无外部 API Key。

### 补全底图

Use case: precise-object-edit. Asset type: animation clean plate for a layered desktop character rig. Edit the supplied 1024x1536 Yoshino character PNG. Preserve the EXACT canvas size, character scale, feet anchor, face, head, hood, ears, blue hair, dress, legs, boots, and puppet on viewer RIGHT. Only remove her free right arm on viewer LEFT: remove the raised-to-chest little fist, the huge tan-and-white cuff and green bent sleeve below her left-on-screen shoulder, roughly x350..550 y440..675. Reconstruct the underlying blue hair, green cloak torso, pink ribbon and white dress that were hidden by this free arm. Keep a small rounded green upper sleeve shoulder socket at x414 y436, blending naturally into the cloak, but no extra hand or detached limb anywhere. This is intentionally an armless clean plate to place articulated arm sprites on top. Match original linework and shading in the reconstructed region, preserve all other pixels as closely as possible. NO mirror, NO pose shift, NO text, NO second character, NO background, no glow. Output one full-canvas PNG with genuine alpha transparency and the exact original image registration; hidden background RGB must not be visible.

### 前臂与张开的手掌

Use case: background-extraction / precise-object-edit. Asset type: transparent aligned forearm sprite for a 2D skeletal desktop-character rig. Input is the exact registration reference, a 1024x1536 full body anime Yoshino. Produce ONLY her free right FOREARM on viewer LEFT, the giant green sleeve, tan geometric cuff, white triangular frill, little pale wrist and OPEN PALM with five fingers. Remove ALL head, hair, body, dress, legs, puppet, and other arm. The forearm remains in its original chest-height diagonal orientation (elbow lower LEFT, hand upper RIGHT). On the output 1024x1536 transparent canvas the rounded green elbow connector is centered at pixel (399,609), with the original sleeve/cuff spanning approximately x393..548 y505..676, wrist centered near (519,511); open palm replacing the original fist extends upward with fingers to about (505,432). Fingers point toward top of canvas, relaxed friendly greeting palm facing viewer, anatomically five fingers. Preserve original sleeve design, exact tan zigzag geometric decoration and white triangular frill, same line weight/colors/shading as reference. The elbow end must have a rounded green cap with enough opaque overlap for a connected rotating upper sleeve. Keep ALL unused canvas transparent and preserve absolute registration: do NOT recenter, do NOT zoom, do NOT crop. It is a tiny isolated sprite in a full-canvas 1024x1536 PNG, occupying only x375..566 y417..687, remaining 90 percent canvas empty alpha. No shadows/background, no glow, no text, no extra objects, no whole character. Actual alpha transparency.

### 上臂袖子

Use case: precise-object-edit / background-extraction. Animation asset, only an isolated green UPPER SLEEVE of the reference anime girl's free right arm, not a complete character. Output 1024x1536 transparent PNG with absolute registration and huge empty margins. Draw a short soft green cloth upper sleeve angled slightly down-left, starts with rounded shoulder cap at (418,430), ends with rounded closed green elbow cap at (399,607). The sleeve silhouette should stay roughly x355..455 y407..638. Broad at elbow, small shoulder cap, no skin, no hands, no cuffs, no tan trim, no white trim, no hair, no rest of body. Match exact original dark green and highlight colors, linework and folded cloth. Shoulder and elbow ends overlap with other sprites, both rounded opaque. Place ONLY this upper sleeve at the requested position, do not recenter/zoom; canvas remains 95% transparent. No glow, no background, no extra limbs or objects.

运行时配置可由 `06-制作脚本/build-rig-v4.mjs` 重新生成；脚本只写 manifest 和 JSON，不编辑角色图片。原始生成文件名对应 body-clean：exec-168fca53-94df-40c0-99c1-ae3ceb79c99c.png；forearm-open：exec-65c76cd8-dafa-4b3c-ba13-2e0256789a42.png；upper-sleeve：exec-8d598aac-01e2-4a7e-8351-5ad6101fcfd9.png。
