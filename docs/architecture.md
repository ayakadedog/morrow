# Morrow 架构说明

安装、日常使用、模型设置、记忆机制及角色制作的完整说明，见 [使用与开发指南](guide.md)。

项目分为桌面宿主、聊天与记忆、角色内容三部分。主进程管理业务状态，React 页面通过 Preload 暴露的业务接口与主进程通信。

## 一次聊天的路径

```text
ChatPanel.tsx → preload/index.ts → main/index.ts
  → ChatService：保存用户输入、管理本轮请求
  → ContextBuilder：装配角色、示例、原文、摘要和记忆
  → ModelClient：通过 LangChain 调用模型
  → 解析回复、保存记录、更新聊天界面
  → CompanionDirector：根据回复安排台词、表情和动作
```

## 关键模块

所有以下路径相对 `src/`。

| 模块 | 职责 |
| --- | --- |
| `main/index.ts` | 应用启动、窗口、托盘、资源协议、IPC 和各服务装配 |
| `main/characters/PackLoader.ts` | 读取与校验角色登记、人设、图片和互动配置 |
| `main/characters/CharacterService.ts` | 角色准备与切换、切换版本管理 |
| `main/chat/ChatService.ts` | 聊天请求、停止、历史操作、摘要和长期资料整理 |
| `main/chat/ContextBuilder.ts` | 装配模型消息并校验回复的台词、署名、表情、动作 |
| `main/chat/ModelClient.ts` | LangChain 模型适配、流式与非流式响应、推理内容 |
| `main/chat/ChatStore.ts` | SQLite 会话、消息、用户原文、确认记忆与数据操作 |
| `main/chat/LongMemory.ts` | 自动长期资料、出处与范围 |
| `main/chat/MemoryRepository.ts` | 新表迁移、证据链接、任务领取与原子提交、删除抑制 |
| `main/chat/MemoryPolicy.ts` | 明确时间、条件和依赖版本的适用性判定 |
| `main/chat/MemoryJobRunner.ts` | 整理任务定时、暂停、租约恢复、重试 |
| `main/chat/MemoryConsolidator.ts` | 有事实依据的增量归纳，人工内容保护 |
| `main/chat/SummaryService.ts` | 稳定摘要条目、增量合并及逐项出处 |
| `main/chat/MemoryLifecycle.ts` | 当前、历史、撤销、待核实等记忆状态及更新来源 |
| `main/chat/ConversationSummary.ts` | 会话摘要的格式、来源和角色版本 |
| `main/chat/DataAdminService.ts` | 管理后台查询、修订和导出 |
| `main/companion/CompanionDirector.ts` | 点击、悬停、拖动、主动陪伴及演出时机 |
| `main/platform/paths.ts` | 开发与打包路径、角色资源路径边界 |
| `renderer/src/ChatPanel.tsx` | 聊天界面 |
| `renderer/src/admin/` | 独立数据管理界面 |
| `renderer/src/FramePlayer.ts`、`MeshPlayer.ts`、`RigPlayer.ts` | 图片帧、局部运动及骨骼分层动作 |
| `shared/` | 跨进程类型、输入校验、角色结构与几何计算 |

## 角色与记忆

每个角色包包含 `manifest.json`、结构化 `role.json`、设定文档、提示词、对白示例、互动配置和运行图片。角色包加载后，由 `ContextBuilder` 组合为系统设定与示范消息；它们不是用户真实聊天记录。

聊天原文、确认记忆、自动来源事实、归纳理解和摘要分别保存。归纳通过 `memory_links` 绑定确切的事实或人工资料版本；来源修改/删除后进入待核实，注入前再次检查依赖。摘要条目保存确切原文来源，旧格式和人工整体编辑明确标记批次出处。

自动整理由 SQLite `memory_jobs` 驱动。普通聊天优先；任务按会话、角色兼容版本与记忆代数合并，领取时获得租约和唯一执行令牌。处理结果、游标和任务完成同一事务提交，旧任务不能覆盖新状态。切换会话不取消有效归档，停止或退出会释放本机任务，异常退出在租约过期后恢复。

聊天原文、确认记忆、自动长期资料和摘要分别保存。注入模型时使用角色、会话、来源、修订版本与记忆状态；模型回复只能指定当前角色允许的演出标签。

角色切换会同步切换内容与聊天空间，并阻止旧请求的迟到结果影响新角色。用户数据不进入角色包。

具体存储结构、实施顺序、验证证据及尚未实现的可选部分，见 [记忆改造实施记录](memory-implementation.md)。

## 构建资源

`electron-builder.yml` 将编译后的 `out/` 打包，并复制登记角色的设定、互动、立绘、表情和动画到应用的资源目录。Windows 为 `resources/characters/`，Mac 为 `Morrow.app/Contents/Resources/characters/`。模板和参考图不进入运行构建。

Windows 的全屏检测 exe 由 C# 源码在构建时生成，只进入 Windows 包，不需要提交二进制。Mac 构建跳过该辅助程序，使用手动安静模式，并额外复制 `resources/icons/` 中的菜单栏模板图标。

Mac 的构建入口为 `scripts/build-macos.mjs`，要求在与目标架构匹配的 Mac 环境运行。验收脚本通过 `scripts/electron-runtime.mjs` 统一选择各平台可执行文件。`verify:platform` 使用隔离数据检查源码与打包资源、角色切换、记忆、后台和重启保存；`Build macOS` 工作流分别使用 arm64 和 Intel Mac 环境构建并运行这些检查。完整安装与分发步骤见 [Mac 使用与构建说明](macos-plan.md)。
