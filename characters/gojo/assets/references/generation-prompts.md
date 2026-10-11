# 五条悟素材生成提示词

使用 Codex 内置 image_gen 工具，2026-10-05。所有运行图为 AI 生成二创初稿，原图保留。背景检查使用 Pillow 只读检查尺寸和 alpha，未用程序重绘人物。

## gojoBasePrompt

Use case: stylized-concept. Asset type: transparent full-body PNG character standing portrait for a Windows desktop companion, 1024x1536 portrait canvas. Subject: Satoru Gojo (五条悟) from Jujutsu Kaisen, adult Tokyo Jujutsu High teacher version. Recognizable tall slender athletic adult man, short spiky snow-white hair rising above a broad matte black cloth blindfold covering both eyes, youthful angular handsome face, relaxed playful confident SMALL CLOSED-MOUTH smile. High-collar very dark navy nearly black fitted jacket, matching dark trousers, simple black ankle boots. No exposed torso. Clean polished Japanese anime cel-shaded fan illustration, precise elegant linework, no photorealism, no chibi proportions. Composition: one figure only, full body fully visible including hair tips and both boots, nearly front-facing slight three-quarter angle, upright relaxed symmetrical weight, both arms relaxed naturally at sides, hands visible and anatomically correct, feet planted at the same horizontal baseline, ample transparent margins around silhouette; head-to-boots span about 86% of canvas height. Genuinely transparent alpha background, no white floor, no shadow beneath feet, no scenery, no halo, no blue energy, no particles, no text, no watermark, no logo, no props or additional characters. This is the neutral base portrait; don't draw an attack pose or hand over blindfold. Save as a PNG asset and return its local saved path if available.

## gojoCleanupPrompt

Use case: background-extraction. Edit target: the attached full-body adult Satoru Gojo desktop portrait. Preserve the character exactly: same white hair, black blindfold, small smile, dark high-collar uniform, anatomy, relaxed arms, boots, pose, position and 1024x1536 canvas. Remove ALL residual background glow, dark background, cloudy haze and colored halos outside the character. Outside the character silhouette alpha must be zero, and the interior of the character (hair, clothes, skin and boots) must be fully opaque; retain antialiasing only at the outline. No shadow under the boots. Do not restyle or move the character. Output a genuinely clean transparent PNG cutout of this exact character.

## gojoPrompt-smile

Edit this exact full-body adult Satoru Gojo desktop-pet cutout. Preserve same canvas 1024x1536, exact character scale, foot placement, pose, arms, outfit, white hair, black blindfold, shading and clean fully transparent background. Change ONLY mouth expression to a visibly cheerful playful broader smile, subtly parted lips with small glimpse of teeth. Do not change body position or crop, no new objects, no light aura, no background. Real alpha transparency.

## gojoPrompt-serious

Edit this exact full-body adult Satoru Gojo desktop-pet cutout. Preserve same canvas 1024x1536, exact character scale, foot placement, pose, arms, outfit, white hair, black blindfold, shading and clean fully transparent background. Change ONLY mouth expression to a clearly calm serious closed neutral mouth, attentive and composed, not angry. Do not change body position or crop, no new objects, no light aura, no background. Real alpha transparency.
