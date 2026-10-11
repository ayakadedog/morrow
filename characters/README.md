# Morrow 角色包

完整的人设编写示例、新增角色步骤及运行检查，见 [使用与开发指南](../docs/guide.md) 的角色相关章节。

当前登记角色为四糸乃（`yoshino`）与五条悟（`gojo`），默认四糸乃。`_template` 是制作模板，未提供图片，不加入角色列表。

## 结构与修改位置

| 文件或目录 | 内容 |
| --- | --- |
| `registry.json` | 角色列表与默认角色 |
| `{id}/manifest.json` | 角色身份、资源路径、说话者、画布与能力声明 |
| `{id}/profile/role.json` | 结构化人设与对白示例，字段由 `src/shared/roleProfile.ts` 校验 |
| `{id}/profile/persona.md` | 补充人物设定 |
| `{id}/profile/prompt.md` | 角色表达与扮演规则 |
| `{id}/interaction/actions.json` | 动作与表情清单 |
| `{id}/interaction/behaviors.json` | 事件、指令、状态、待机与周期演出的绑定 |
| `{id}/interaction/dialogues.json` | 固定互动回应组和台词 |
| `{id}/interaction/bubble.json` | 气泡主题与快捷按钮 |
| `{id}/assets/portraits/`、`assets/expressions/`、`assets/animations/` | 程序使用的图片及动作配置 |
| `{id}/assets/references/` | 来源与制作说明、参考图；不进入运行构建 |

语音暂缓，不需要声音文件。角色包中不保存模型密钥、聊天记录或用户记忆。

## 新增角色

1. 将 `_template` 复制为新目录，使用稳定的小写 ID，例如 `my-character`。
2. 修改 manifest 中的 ID、名称、说话者和资源映射；修改三份设定文件，确保 `role.json.characterId` 与 manifest 一致。
3. 提供所声明的透明 PNG。图片画布必须与 `visual.canvas` 一致，默认与回退表情必须存在。
4. 配置动作清单、事件绑定、固定台词和气泡。动作、表情、说话者 ID 必须在当前包中存在；不要求沿用四糸乃的 ID。
5. 在 `registry.json.characters` 登记 `{ "id": "my-character", "manifest": "my-character/manifest.json" }`。
6. 在仓库根目录执行 `npm run roles:validate`，再运行应用检查加载、图片解码和互动。此命令只校验登记与人设；完整资源校验由应用的 PackLoader 执行。
7. 运行版通过 `npm run pack` 更新角色资源，重启后刷新角色列表。

所有 manifest 资源路径相对当前角色目录，使用 `/`；不要使用绝对路径、`..` 或符号链接。

## 记忆兼容版本

`manifest.json` 可选 `memoryCompatibilityVersion`，例如 `"canon-v1"`。默认不填时，角色 ID、结构化设定、补充设定和提示词共同生成严格版本；修改后旧自动事实与摘要不会混入。填写后，角色 ID 与该兼容版本决定记忆隔离，措辞微调可沿用资料；修改身份、世界线或重要背景时必须更换版本。由作者明确声明兼容，程序不猜测设定是否兼容。请求诊断仍记录完整提示版本哈希，便于排查。人工现实资料按角色隔离，剧情资料再绑定会话。

## 动作扩展

四糸乃提供帧动画、局部运动和分层骨骼配置，分别见 `sequences-v2.json`、`motions-v3.json`、`rig-v4.json`。五条悟使用基础动作配置。新角色需要按自身素材重新设计画布位置、蒙版和关节，不能直接复用其他角色的坐标。

实际配置格式与边界以 `src/main/characters/PackLoader.ts`、`src/shared/rig.ts` 及运行播放器为准。

## 素材来源

运行图片是 AI 生成的同人设计稿。保留了角色来源、生成提示词、分层动作说明和五条悟示例出处说明；重复的生成原图留在原项目中，不随本仓库整理副本提供。
