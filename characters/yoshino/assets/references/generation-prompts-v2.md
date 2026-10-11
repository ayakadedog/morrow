# 四糸乃 v2 动作与表情生成记录

日期：2026-10-03。工具：内置 imagegen；没有使用 CLI 或用户 API Key。
所有图为 AI 同人素材初稿；不覆盖现有图片。原有 normal 为初始身份基准，其余表情/眨眼/动作中间图引用同一 v2 normal；动作终态另参考对应中间姿态。

## normal

Use case: background-extraction / identity-preserve. Edit target Image 1: the existing Yoshino / 四糸乃 full-body desktop sprite. Create a clean canonical animation base, one full-body character plus her existing hand puppet, in a 1024x1536 portrait PNG with genuine alpha transparency. CRITICAL: remove ALL diffuse green/blue/grey/dark halo, background gradients and shadow outside the sharply defined character and puppet silhouette, including empty gaps. Empty background must have alpha 0, not a painted black/white/checker background. Preserve the original character exactly: face and gentle neutral expression, long blue wavy hair, green rabbit hood and long ears, pink/yellow ear stitching, cream zigzag trim, white layered dress, green boots and yellow bead decorations. White Yoshinon rabbit puppet remains in HER OWN LEFT HAND (viewer RIGHT), with identical smiling face, button eyepatch and orange bow. Her other hand stays near her chest. Preserve face shape, body proportions, detailed costume, identity, anime linework, cel shading, natural pose, full ears and both feet, original scale and position. Do not mirror. No text, no props, no watermark. This is a clean cutout edit, not a redesign. Keep original 1024x1536 composition unchanged with all extremities in frame.

输入图片：assets/portraits/normal.png

（本机生成输出路径已省略，原图留在原项目。）

## happy

Use case: identity-preserve. Image 1 is the canonical EDIT TARGET, Yoshino / 四糸乃 with Yoshinon puppet. Produce ONE full-body transparent PNG expression/animation frame, same 1024x1536 portrait canvas as Image 1. STRICT invariants: preserve EXACT same body, pose, face shape, head position, blue hair waves and strands, green rabbit hood including both long ears and pink stitch patches, cream trim, white ruffle dress, buttons, cuffs, boots, shading, fine anime linework, silhouette, scale, foot position and complete framing. Her right hand (viewer LEFT) remains at chest; white Yoshinon puppet stays in her own LEFT hand (viewer RIGHT) and its face, bow, ears and position are unchanged. Change ONLY the explicitly requested facial feature below. No mirroring, no new accessories, no redrawing costume, no background/glow/shadow/text/watermark; retain genuine alpha transparency outside character. Identity and spatial continuity across frames take priority over creative redesign. ONLY change the girl's mouth to a small warm happy smile and gently soften her eyebrows, keeping the same open blue eyes and gaze. Very faint cheerful blush, restrained and gentle, no open-mouthed grin.

输入图片：assets/portraits/v2/normal.png

（本机生成输出路径已省略，原图留在原项目。）

## shy

Use case: identity-preserve. Image 1 is the canonical EDIT TARGET, Yoshino / 四糸乃 with Yoshinon puppet. Produce ONE full-body transparent PNG expression/animation frame, same 1024x1536 portrait canvas as Image 1. STRICT invariants: preserve EXACT same body, pose, face shape, head position, blue hair waves and strands, green rabbit hood including both long ears and pink stitch patches, cream trim, white ruffle dress, buttons, cuffs, boots, shading, fine anime linework, silhouette, scale, foot position and complete framing. Her right hand (viewer LEFT) remains at chest; white Yoshinon puppet stays in her own LEFT hand (viewer RIGHT) and its face, bow, ears and position are unchanged. Change ONLY the explicitly requested facial feature below. No mirroring, no new accessories, no redrawing costume, no background/glow/shadow/text/watermark; retain genuine alpha transparency outside character. Identity and spatial continuity across frames take priority over creative redesign. ONLY change facial expression to gentle shy embarrassment: restrained blush on cheeks, slightly hesitant eyebrows and a small shy mouth. Keep eyes open, exact head angle and body pose; do not lower head or move her hands in this expression-only variant.

输入图片：assets/portraits/v2/normal.png

（本机生成输出路径已省略，原图留在原项目。）

## blink-half

Use case: identity-preserve. Image 1 is the canonical EDIT TARGET, Yoshino / 四糸乃 with Yoshinon puppet. Produce ONE full-body transparent PNG expression/animation frame, same 1024x1536 portrait canvas as Image 1. STRICT invariants: preserve EXACT same body, pose, face shape, head position, blue hair waves and strands, green rabbit hood including both long ears and pink stitch patches, cream trim, white ruffle dress, buttons, cuffs, boots, shading, fine anime linework, silhouette, scale, foot position and complete framing. Her right hand (viewer LEFT) remains at chest; white Yoshinon puppet stays in her own LEFT hand (viewer RIGHT) and its face, bow, ears and position are unchanged. Change ONLY the explicitly requested facial feature below. No mirroring, no new accessories, no redrawing costume, no background/glow/shadow/text/watermark; retain genuine alpha transparency outside character. Identity and spatial continuity across frames take priority over creative redesign. ONLY edit both girl's upper eyelids to the halfway closed stage of a natural blink, leaving the lower part of the blue irises visible. Lower lids, eyebrows, mouth and facial identity unchanged. Both eyes half closed symmetrically. No change to body or head.

输入图片：assets/portraits/v2/normal.png

（本机生成输出路径已省略，原图留在原项目。）

## blink-closed

Use case: identity-preserve. Image 1 is the canonical EDIT TARGET, Yoshino / 四糸乃 with Yoshinon puppet. Produce ONE full-body transparent PNG expression/animation frame, same 1024x1536 portrait canvas as Image 1. STRICT invariants: preserve EXACT same body, pose, face shape, head position, blue hair waves and strands, green rabbit hood including both long ears and pink stitch patches, cream trim, white ruffle dress, buttons, cuffs, boots, shading, fine anime linework, silhouette, scale, foot position and complete framing. Her right hand (viewer LEFT) remains at chest; white Yoshinon puppet stays in her own LEFT hand (viewer RIGHT) and its face, bow, ears and position are unchanged. Change ONLY the explicitly requested facial feature below. No mirroring, no new accessories, no redrawing costume, no background/glow/shadow/text/watermark; retain genuine alpha transparency outside character. Identity and spatial continuity across frames take priority over creative redesign. ONLY close both girl's eyes naturally for the closed stage of a blink; softly curved closed eyelid lines in the original eye locations. Preserve eyebrows, mouth and neutral expression, do not smile or blush or move head. No eyes visible through the closed lids.

输入图片：assets/portraits/v2/normal.png

（本机生成输出路径已省略，原图留在原项目。）

## greet-mid

Use case: identity-preserve. Image 1 is the canonical EDIT TARGET, existing Yoshino / 四糸乃 transparent full-body desktop sprite with her Yoshinon rabbit puppet. Create ONE subtle action keyframe in EXACT same 1024x1536 portrait composition. Lock identity, face shape, blue hair, green rabbit hood and long pink-patched ears, cream stitching/zigzag trim, white layered dress, boots, buttons, colors, fine anime linework, cel shading, body scale, leg pose and foot placement. Keep the whole character and both ears and feet uncropped. Feet/legs/lower coat and puppet are stationary. Puppet remains on her OWN LEFT hand (viewer RIGHT), identical shape, face, bow and position; do not mirror. True alpha transparency outside character, no scene, no gradients/glow/shadow/text/watermark. Changes confined to specifically requested local pose, NOT whole-image rotation or translation. Action: FIRST MIDDLE FRAME of a gentle greeting. Move ONLY her free OWN RIGHT hand (viewer LEFT) from its original closed position at chest into a HALF-RAISED greeting: the elbow remains bent, palm begins opening naturally near upper-chest/shoulder height, fingers angled slightly upward and wrist relaxed. Small movement only: the hand is midway on the path toward waving near her cheek, NOT yet fully raised. Replace the old hand pose, do not add an extra hand. Adapt the right sleeve minimally around bent forearm, preserving all trim details. Keep head, hood, eyes, left puppet arm, torso, hips and feet locked; a very small warm smile allowed. Five natural fingers.

输入图片：assets/portraits/v2/normal.png

（本机生成输出路径已省略，原图留在原项目。）

## shy-mid

Use case: identity-preserve. Image 1 is the canonical EDIT TARGET, existing Yoshino / 四糸乃 transparent full-body desktop sprite with her Yoshinon rabbit puppet. Create ONE subtle action keyframe in EXACT same 1024x1536 portrait composition. Lock identity, face shape, blue hair, green rabbit hood and long pink-patched ears, cream stitching/zigzag trim, white layered dress, boots, buttons, colors, fine anime linework, cel shading, body scale, leg pose and foot placement. Keep the whole character and both ears and feet uncropped. Feet/legs/lower coat and puppet are stationary. Puppet remains on her OWN LEFT hand (viewer RIGHT), identical shape, face, bow and position; do not mirror. True alpha transparency outside character, no scene, no gradients/glow/shadow/text/watermark. Changes confined to specifically requested local pose, NOT whole-image rotation or translation. Action: FIRST MIDDLE FRAME of shy head-lowering. Make a very small anatomically real downward nod at the neck, approximately 3 degrees, eyes looking slightly lower and faint cheek blush. Chin lowers a little relative to shoulders, ONLY head/face and tiny hair overlap respond. Do not rotate the entire image, do not sway body, do not move feet, arms, hands or puppet. Keep hood shape and ears as stable as possible; preserve facial identity and all garments. This is HALF of a subtle 6-degree shy nod, not a deep bow. Mouth small and hesitant.

输入图片：assets/portraits/v2/normal.png

（本机生成输出路径已省略，原图留在原项目。）

## greet-peak

Use case: identity-preserve. Image 1: canonical Yoshino / 四糸乃 EDIT TARGET (neutral standing). Image 2: supporting middle-frame reference ONLY to continue the exact same action, not a new character or style. Produce ONE final action keyframe with EXACT same 1024x1536 portrait canvas, body scale, stationary hips/legs/feet, complete head ears and boots uncropped. Preserve canonical identity, body proportions, face shape, blue hair, green rabbit hood with long pink-patched stitched ears, cream zigzag trim, white layered dress, boots and beads, detailed costume and fine anime cel-shading. Yoshinon puppet and HER OWN LEFT hand (viewer RIGHT) remain fixed at original chest location with identical face and bow. No mirroring, no extra hands, no new ornaments, no redesign. Genuine alpha transparency outside silhouette, no background, no halo/glow/shadow/text/watermark. Action: FINAL gentle greeting, continuing Image 2's half-raised free right hand. Raise that SAME free RIGHT hand on viewer LEFT slightly farther upward and outward so the open palm is beside her cheek/temple; wrist a little above shoulder height, fingers point up, fingertips near the level of her eyes. The palm should be about 60 pixels higher and 40 pixels farther toward viewer left than in Image 2 on the 1024x1536 canvas. Only right forearm/hand and its sleeve adjust naturally, keep elbow close and five fingers. Maintain gentle small happy smile; head/hood/torso/puppet/lower body stay in canonical position. A restrained shy wave pose, NOT exaggerated reaching or jumping. Replace old free hand; do not leave a second free hand at chest.

（本机生成输出路径已省略，原图留在原项目。）

（本机生成输出路径已省略，原图留在原项目。）

## shy-peak

Use case: identity-preserve. Image 1: canonical Yoshino / 四糸乃 EDIT TARGET (neutral standing). Image 2: supporting middle-frame reference ONLY to continue the exact same action, not a new character or style. Produce ONE final action keyframe with EXACT same 1024x1536 portrait canvas, body scale, stationary hips/legs/feet, complete head ears and boots uncropped. Preserve canonical identity, body proportions, face shape, blue hair, green rabbit hood with long pink-patched stitched ears, cream zigzag trim, white layered dress, boots and beads, detailed costume and fine anime cel-shading. Yoshinon puppet and HER OWN LEFT hand (viewer RIGHT) remain fixed at original chest location with identical face and bow. No mirroring, no extra hands, no new ornaments, no redesign. Genuine alpha transparency outside silhouette, no background, no halo/glow/shadow/text/watermark. Action: FINAL subtle shy downward nod, continuing Image 2's halfway nod. Lower chin a little more at the neck (about 6 degrees total from canonical standing), gaze gently downward, upper eyelids modestly lowered (NOT completely closed), mild rosy cheeks and a small hesitant mouth. Keep the SAME identity and head size, no childlike face redesign. Hair and hood around head respond minimally to real local neck movement. No whole-image rotation or translation, no lateral head tilt. Hands, shoulders, feet, lower clothes and puppet remain fixed to Image 1; neck/face/head movement is small and believable rather than a deep bow.

（本机生成输出路径已省略，原图留在原项目。）

（本机生成输出路径已省略，原图留在原项目。）
