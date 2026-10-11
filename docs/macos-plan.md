# Morrow Mac 使用与构建说明

调研日期：2026-10-05。目标用途：发给少量朋友使用。

当前已接入 Mac 平台分支、DMG 构建、菜单栏图标、应用菜单、Dock 重新打开、桌面 Spaces 和跨平台验收。Windows 本地检查与 Mac 实机验证分开记录；当前尚未生成、验证 Mac 安装包。

## 0. 现在怎么使用

### 0.1 先在一台 Mac 上生成安装包

你目前选择先在本地处理，因此无需上传 GitHub。把项目源码带到 Mac 上，在包含 package.json 的目录中打开终端。不要一起搬运 Windows 的 node_modules、native、out、release 或个人 data；这些内容在 Mac 上重新生成。

构建者需要 Node.js 24 或以上版本及 npm，执行：

```bash
npm ci
npm run dist:mac
npm run verify:platform:packaged
```

构建成功后，release/ 中的 `Morrow-版本-arm64.dmg` 可发给 Apple 芯片 Mac 的朋友，`Morrow-版本-x64.dmg` 可发给 Intel Mac 的朋友。每台构建机默认生成自己的架构；要提供两种安装包，应分别在匹配架构的 Mac 上构建，或使用后面的双架构工作流。

朋友安装应用不需要 Node.js：打开 DMG，把 Morrow.app 拖进 Applications（应用程序），随后从应用程序启动，填写模型配置。API Key 使用自己的密钥。

### 0.2 先测试源码或 .app

源码开发：

```bash
npm ci
npm run build
npm run verify:platform
npm run dev
```

只生成未装入 DMG 的 .app：

```bash
npm run pack:mac
npm run verify:platform:packaged
```

| 架构 | 未打包进 DMG 的应用位置 |
| --- | --- |
| Apple Silicon arm64 | release/mac-arm64/Morrow.app |
| Intel x64 | release/mac/Morrow.app |

不要仅把 .app 里的主可执行文件发给朋友；DMG 包含完整应用资源。

### 0.3 以后使用 GitHub 自动构建

工作流已保存在 [build-macos.yml](../.github/workflows/build-macos.yml)，当前没有上传或运行它。以后将项目放在 GitHub 仓库根目录，并将工作流上传到默认分支：

1. 打开仓库 Actions 页面，选择 **Build macOS**。
2. 点击 **Run workflow**，架构选择 both、arm64 或 x64。
3. 等待安装依赖、单元测试、DMG 构建、源码与打包版基本验收、签名完整性检查完成。
4. 在该次运行的 Artifacts 下载 `Morrow-macos-arm64` 或 `Morrow-macos-x64`。
5. 解开下载的 ZIP，把里面的 DMG 发给对应架构的朋友。

`Morrow-macos-架构-reports` 是验收报告。DMG 只有在该架构的检查步骤通过后才上传，产物保留 14 天。工作流手动触发，使用只读仓库权限，不自动提交代码或发布 Release。

### 0.4 第一次打开

当前配置采用 **ad-hoc 签名**，没有 Developer ID 身份认证和 Apple 公证。这是供少量朋友测试的版本，不能把签名完整性检查成功理解为 Gatekeeper 已认可开发者。

首次打开遇到“无法验证开发者”或未公证提示时，按照 Apple 的官方说明，在尝试打开后进入“系统设置 → 隐私与安全 → 仍要打开”。如果提示文件损坏，应先重新下载、确认签名与安装包完整性。[Apple 首次打开说明](https://support.apple.com/en-us/102445)

首次下载、钥匙串授权和实际窗口表现需要在接收安装包的 Mac 上验证，构建机上的自动检查不能完全代替这一过程。

## 1. 推荐方案

继续使用现有 Electron、React 和 TypeScript 代码，增加 macOS 的构建分支，用 Mac 本机或 GitHub Actions 的 macOS 环境生成 DMG 安装包。第一版保留角色、聊天、图片、历史、记忆和数据管理，把 Windows 专用的自动全屏检测暂时降级为手动安静模式。

朋友的使用流程应当是：下载适合自己电脑的 DMG → 把 Morrow.app 拖到 Applications（应用程序）→ 打开 → 填写模型地址、模型名称和自己的 API Key。

项目已经使用 Electron 的透明窗口和鼠标穿透接口。Electron 的鼠标事件转发支持 macOS；跨桌面空间也有专用接口。实际拖动、窗口层级、焦点和全屏空间表现仍需在 Mac 上验收。[Electron 窗口 API](https://www.electronjs.org/docs/latest/api/browser-window)

## 2. 已完成的适配入口

| 文件或模块 | 适配前状态 | 本次处理 |
| --- | --- | --- |
| [build-native.mjs](../scripts/build-native.mjs) | 每次构建都调用 Windows 的 csc.exe | 已仅在 win32 编译；macOS 跳过此辅助程序 |
| [electron-builder.yml](../electron-builder.yml) | 只有 Windows NSIS；全局复制 foreground-observer.exe | 已隔离 Windows 资源；增加 macOS DMG、ad-hoc 签名和应用程序快捷入口 |
| [package.json](../package.json) | pack 和 dist:win 写死 Windows x64 | 已增加 pack:mac、dist:mac、verify:platform |
| [FullscreenObserver.ts](../src/main/platform/FullscreenObserver.ts) | 非 Windows 已返回 unavailable | 第一版沿用此降级，不阻止聊天和角色运行 |
| [主进程入口](../src/main/index.ts) | Windows AppUserModelId；托盘和窗口按现有桌面习惯实现 | 已增加平台判断、Mac 菜单、模板图标、Dock 再打开与普通 Spaces 显示 |
| scripts/start.cmd、start.ps1 | Windows 启动脚本 | Mac 安装版直接打开 .app；开发文档补充终端命令 |
| scripts/verify-*.mjs | 打包验收读取 Windows exe | 已统一跨平台路径；陪伴验收跳过 Mac 不支持的原生全屏检测；增加基础验收脚本 |
| README、guide | 原先只说明 Windows 支持 | 已补充 Mac 入口、命令、分发说明和待验证范围 |

聊天、记忆、角色加载和界面大部分代码可以共用。上表是已定位的适配入口，不能代替最终的 Mac 运行测试。

## 3. 怎样生成安装包

### 有一台 Mac 可以借用

在 Mac 上安装项目要求的 Node.js 24 或以上版本，通过 npm ci 安装依赖，再执行本页第 0 节的 Mac 构建命令。不要从 Windows 直接复制 node_modules、native、out 或 release 来代替 Mac 构建。

### 继续在 Windows 开发

手动触发的 macOS 构建工作流已准备好。以后上传代码后，在 Actions 页面启动构建，下载产物，再把 DMG 发给朋友。产物保留为 Actions artifact，稳定后再决定是否上传 Release。

GitHub 官方提供 Intel 和 Apple Silicon 的 macOS 构建环境；当前可使用 macos-15-intel 对应 x64、macos-15 对应 arm64。工作流应明确指定架构，避免跟随 macos-latest 的变化。[GitHub 托管运行器](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)

Mac 构建和签名放在 macOS 环境中完成；尤其 macOS 签名只能在 macOS 上执行。Windows 上写代码、由远程 Mac 构建是一条可行的流程。[electron-builder 跨平台构建说明](https://www.electron.build/v26/docs/features/multi-platform-build/)

### 两种 Mac 下载哪个

| 电脑 | 构建架构 | 建议产物 |
| --- | --- | --- |
| Apple 芯片 Mac，M 系列 | arm64 | Morrow-版本-arm64.dmg |
| Intel 芯片 Mac | x64 | Morrow-版本-x64.dmg |

可以先只构建朋友实际使用的架构。也可以生成同时包含两种架构的 universal 包，但第一版分别构建更方便定位问题。electron-builder 支持这三种架构和 DMG 格式。[electron-builder 26 的 macOS 配置](https://www.electron.build/v26/docs/mac/)

最终最低 macOS 版本需要根据当前 Electron 版本的支持范围和实机结果确定，不能仅凭“支持 Mac”承诺所有老电脑都能运行。

## 4. 少量朋友使用时，怎样处理签名

### 先做测试版

初期可以不购买 Developer ID 证书，制作未经过 Apple 公证的测试包；仍要正确处理应用自身的签名要求，尤其 Apple Silicon，不能把“无付费证书”理解为任意去掉全部签名。

系统可能拦截第一次打开。对于来源确定、完整性可信的测试包，Apple 给出的操作是：先尝试打开应用，再到“系统设置 → 隐私与安全”选择“仍要打开”，确认后再次打开。受单位管理的电脑可能不允许此操作。[Apple 官方打开说明](https://support.apple.com/en-us/102445)

这一流程需要在朋友的 Mac 上验证，不能保证所有系统设置下都只需一次确认。若提示应用损坏，应先检查签名、打包和下载完整性。

### 想让朋友安装更顺畅

使用 Developer ID 签名并完成 Apple 公证，仍可直接分发 DMG，无需先上 Mac App Store。当前配置固定为测试版 `identity: "-"`、`hardenedRuntime: false`、`notarize: false`；正式分发时需改成证书身份，开启 hardenedRuntime 和 notarize，并配置证书、公证凭据与适当的 entitlements。当前工作流未读取这些付费签名凭据。[Electron 签名与公证说明](https://www.electronjs.org/docs/latest/tutorial/code-signing)

Apple Developer Program 的官方费用为每会员年 99 美元，地区价格以注册页面为准。对目前少量朋友测试的用途，可以先验证应用，再决定是否承担这项费用。[Apple 开发者计划注册与费用](https://developer.apple.com/programs/enroll/)

## 5. 第一版的功能范围

| 功能 | 第一版建议 |
| --- | --- |
| 桌面角色、切换角色、表情和互动气泡 | 保留；验收透明背景、拖动和鼠标穿透 |
| 聊天、模型设置、图片、会话历史 | 保留；验收流式输出和文件选择 |
| 长期记忆、摘要、数据管理 | 保留；验收重启保存与导出 |
| 菜单栏入口、显示隐藏、退出 | 适配 Mac 使用习惯 |
| 手动“安静 30 分钟” | 保留，源码已有此功能 |
| 识别其他应用全屏并自动安静 | 暂不支持；后续单独设计 Mac 检测实现 |
| 跨 Spaces、全屏应用上方的显示策略 | 已配置跨普通桌面 Spaces；全屏应用上方不主动显示，仍待实机验收 |
| 自动更新 | 后续需求，第一版通过替换应用升级 |

没有必要为第一版重写 Swift 或更换桌面框架。改成网页会改变桌面角色的使用方式，也不符合现有透明悬浮窗口的主要用途。

## 6. API Key 与数据

当前 API Key 使用 Electron safeStorage 保存。macOS 使用 Keychain，Windows 使用 DPAPI，所以 Mac 上应重新填写 API Key，不应直接搬用 Windows 的加密配置。Mac 测试包还要验收 Keychain 提示、退出后重新打开以及升级后的密钥读取；签名不一致可能导致更新后再次请求钥匙串访问许可。[Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)

聊天数据库与角色素材有复用基础，但跨系统迁移应单独验证，不能直接承诺复制整个 Windows 数据目录即可使用。关闭应用并备份后，再迁移所需数据库；模型密钥在新系统重新配置。安装包应只包含程序和公共角色资源，不包含你的个人聊天记录或 API Key。

## 7. 发给朋友前的验收

1. 在对应架构的 Mac 上生成 .app 和 DMG；确认角色资源完整。
2. 在一台实际收到下载文件的 Mac 上测试首次安装，而不只测试构建机本地运行。
3. 检查透明背景、拖动、置顶、鼠标穿透、气泡点击和多显示器边界。
4. 检查菜单栏、Dock、关闭聊天面板后继续运行以及完全退出。
5. 检查桌面空间切换、其他应用全屏、锁屏和睡眠恢复。
6. 填写模型配置并完成一次聊天；重启确认密钥、历史和记忆可读取。
7. 运行角色校验、类型检查和适用的测试；补充 Mac 桌面验收记录。
8. 替换新版应用后确认数据保留，附上实际支持的系统版本与首次打开说明。

## 8. 推荐实施顺序

先处理平台分支和打包配置，再增加 GitHub Actions Mac 构建，产出朋友所需架构的测试包；完成实机验收后分发。若朋友频繁遇到首次打开或更新后的钥匙串问题，再补充稳定的 Developer ID 签名与公证。

当前已完成平台适配代码、Mac 构建命令、基础验收和工作流配置；Mac 安装包生成及实机验收待完成。当前开发机为 Windows，尚未执行远程 Mac 构建。

### 8.1 本次本地检查记录

2026-10-05，在 Windows 上完成：

- 角色校验、TypeScript 类型检查和完整构建通过。
- 15 个单元测试文件、201 项测试通过。
- Windows 运行目录重新打包通过，Windows 全屏检测辅助程序仍包含在包中。
- 跨平台基础验收脚本分别对源码与 Windows 打包版通过，检查角色切换、资源解码、沙箱、穿透状态、手动安静、聊天入口、记忆、后台及重启保存。
- 现有源码聊天验收通过，覆盖流式、取消、角色隔离、历史编辑、确认记忆、摘要和持久化；使用本地模拟接口，没有验证外部服务商。
- electron-builder 配置通过当前安装版本的配置格式校验；工作流 YAML、命令引用、模板图标尺寸及 Markdown 本地链接检查通过。

这份记录不代表 Mac 已经启动成功。Mac DMG 构建、ad-hoc 签名完整性、首次下载验证、钥匙串与实际桌面行为仍要在 Mac 上完成。
