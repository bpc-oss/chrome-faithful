# Chrome Faithful

**忠实控制你真实、已登录的 Chrome 配置文件。**

一个 MCP 服务 + MV3 Chrome 扩展 + 经认证的本地桥接，让 AI 智能体驱动**已经持有你登录态、扩展和历史记录的 Chrome**。不复制配置文件、不使用调试配置文件、不开 `--remote-debugging-port`、不用 Edge、不做全局鼠标/键盘自动化。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/bpc-oss/chrome-faithful/actions/workflows/ci.yml/badge.svg)](https://github.com/bpc-oss/chrome-faithful/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D22.12-339933)

[English](README.md) · **简体中文**

---

## 为什么存在

不同浏览器控制工具针对的是不同任务：

| 方案 | 你得到什么 | 你失去什么 |
|---|---|---|
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)（Google 官方） | 很强的 DevTools、性能与 CDP 工作流；Chrome 144+ 可经用户授权 `autoConnect` 到已运行的本地浏览器 | Chrome 必须已经运行；多个 Profile 活跃时由 Chrome 选择默认 Profile，不能按名称精确指定 |
| Playwright / Puppeteer MCP 服务 | 确定、隔离的浏览器，非常适合 CI 与可重复测试 | 现有登录态、扩展、历史与双因素会话需要另行配置 |
| 基于扩展的 MCP（[BrowserMCP](https://github.com/browsermcp/mcp)、[real-browser-mcp](https://github.com/ofershap/real-browser-mcp)） | 控制已有登录态的浏览器 | 很适合实时会话；多 Profile 可能需要分别运行服务和端口，通常也要求 Chrome 已经运行 |

Chrome Faithful 聚焦于 fail-closed 本地桥接下的精确、多 Profile 控制：

- **精确多 Profile 路由。** 每个 Profile 以精确的 `profileName` 注册；重复注册会被拒绝，并发智能体无法在同一 Profile 内互相干扰。
- **能拉起已关闭的 Profile。** 目标 Profile（或整个 Chrome）关闭时，用普通 Chrome 启动*精确的* Profile，并在扩展精确注册后才报告成功。没有 `--user-data-dir` 这类 hack。
- **安全纵深。** 桥接只绑定 `127.0.0.1` 并要求生成的 256-bit 密钥。引导使用一次性 token；会话使用作用域授权。配置是闭环 schema 且必须存放在源码树之外。安装器是事务式的，带 SHA-256 校验、DPAPI 加密备份（Windows）。
- **文件上传走正路。** 文件以页面 `File`/`DataTransfer` 对象注入——不用 `DOM.setFileInputFiles`，不用系统文件选择器。
- **媒体导出不泄露 URL。** `chrome_page_asset` 使用该标签页的 UA、referer 和对应 Profile 的 Cookie 流式导出页面媒体；签名 URL、Cookie、Header 永不进入 MCP 参数或结果。
- **持久化虚拟列表采集。** 滚动采集带资产校验、fail-closed 清单、跨进程独占锁，以及通过串行化滚轮事件回卷标签页的续采——为无限滚动信息流而生。
- **窗口最小化也能工作。** 定位器等待/操作与截图使用 CDP focus 仿真，窗口最小化或被遮挡时虚拟化控件仍能渲染。
- **需要时可用原始 CDP，并明确划定信任边界。** `chrome_cdp` 的事件读取会脱敏 Network header、查询参数和 post data；有界请求/响应投影会拒绝选择敏感字段。但 `send` 是刻意保留的无限制原始 CDP，只能交给完全可信的 MCP 客户端：它可以读取已登录页面内容、Cookie、存储、token、URL 与 header。
- **结构化验证处理。** 多信号挑战检测，区分*已解决* / *待渲染* / *活动挑战*三种状态；对常见的"点一下就能过"场景采用**点击优先**求解；需要人工时给出诚实的交接——见[验证处理](#验证处理)。
- **Codex 兼容 JS API。** `src/agent-browser.mjs` 实现 Codex 的 `agent.browsers` 接口（标签页、定位器、CUA、Playwright 风格选择器、剪贴板、对话框、下载），JS 智能体可直接使用同一运行时。

## 架构

```
┌─────────────┐   stdio    ┌──────────────────────┐   ws://127.0.0.1    ┌─────────────────────────┐
│ MCP 客户端   │ ─────────► │ src/mcp-server.mjs   │ ──────────────────► │ src/bridge-server.mjs   │
│ (Claude、   │            │ MCP 工具 (38 个)      │  (Bearer 密钥)       │ 经认证的 localhost       │
│  Codex、…)  │            └──────────────────────┘                     │ 多 Profile 路由器        │
└─────────────┘                                                        └───────────┬─────────────┘
                                                                                    │ chrome.debugger
                                                                    ┌───────────────▼──────────────┐
                                                                    │ 每个精确 Profile 中的         │
                                                                    │ MV3 扩展（offscreen 文档持有  │
                                                                    │ 持久 WebSocket）              │
                                                                    └──────────────────────────────┘
```

- `extension/` — 在每个可控制 Profile 中加载一次的 MV3 扩展。使用 `chrome.debugger`；**offscreen 文档**持有持久 WebSocket，MV3 服务工作线程被挂起也不会断连。
- `src/bridge-server.mjs` — 经认证、仅 localhost、带弹性故障转移的多 Profile 路由器。
- `src/chrome-profile-launcher.mjs` — 精确本地 Profile 发现 + 普通 Chrome 启动，带限时扩展注册确认。
- `src/mcp-server.mjs` — MCP 工具面（38 个工具）。
- `src/agent-browser.mjs` — JavaScript `agent.browsers` 兼容适配层。
- `src/verification/` — 挑战检测、hold 状态机、人工交接、遮罩清理、拟人输入，以及求解管线（checkbox / 滑块 / 点击优先 generic / capture 送后端）。
- `src/file-injection.mjs`、`src/page-asset.mjs`、`src/scroll-capture.mjs`、`src/scroll-asset-capture.mjs`、`src/network-request.mjs`、`src/network-response.mjs` — 功能模块。
- `scripts/` — Windows 安装器、验收工具、实机测试工具、Codex parity 工具。

## 安全模型

1. 调用方必须选择一个精确的 `metadata.profileName`。
2. 同一 Profile 名的重复在线注册会被拒绝。
3. 桥接只绑定 `127.0.0.1` 并要求生成密钥。
4. 绝不回退到通用 Profile、9222 端口、Edge 或 UI 自动化。
5. 目标断开时，调用方使用 `chrome_profile_catalog` / `chrome_profile_start`；只有精确扩展 `profileName` 注册后，进程启动才算成功。
6. 浏览器工作前必须通过标签页与 `Runtime.evaluate` 的在线自检。
7. Profile 与标签页失败直接返回给调用智能体，无需用户侧控制台检查。

`chrome_cdp` 的 `action=send` 不属于安全投影边界；它等同于把所选已登录 Profile 的 DevTools 权限交给 MCP 客户端。不要把该服务暴露给不可信客户端或共享 MCP 主机。

完整模型与上报策略见 [SECURITY.md](SECURITY.md)。

扩展的高权限是刻意且公开的：`debugger` 提供等同 DevTools 的控制；
`history`、`downloads` 与剪贴板权限支撑对应工具。Host 访问仅限
`http://127.0.0.1/*` 本地桥接。若需要确定、一次性的 CI 浏览器，应使用
Playwright 或 Puppeteer。

## DSH 一等集成

Chrome Faithful 在 `packages/dsh-plugin-chrome-faithful/` 提供第一方
DeepSeek Harness bundle。它复用 DSH 宿主提供的 MCP Client，不复制浏览器
工具，因此 DSH 与其他客户端共享完全相同的精确 Profile 路由与安全行为。

已验证基线为 `@deepseek-ai/dsh` `0.1.0-rc.6`，Node.js 要求
`>=22.12.0`。DSH 仍处于 RC 阶段，每次升级 RC 都需要重新验证组合契约。

核心包和 bundle 发布后，可安装到目标 Profile：

```sh
dsh plugin --profile web add @bpc-oss/dsh-plugin-chrome-faithful@0.4.0
```

模型看到的是 `mcp__chrome_faithful__chrome_profiles` 等稳定名称。bundle
不嵌入密钥，仅在显式设置时传递 `AGENTOS_CHROME_CONFIG`；初始配置或解析
失败会中止激活，不会静默留下零工具插件。打包、信任边界和私有验收规则见
[DSH bundle README](packages/dsh-plugin-chrome-faithful/README.md)。

### 面向纯文本模型的本地视觉

`chrome_visual_extract` 只在显式调用时截取所选精确 Profile 的标签页，并把
截图交给本地后端；返回的是文字 JSON，包括截图尺寸/SHA-256、OCR 文字、
置信度与归一化坐标，不返回也不保存 PNG。因此即使 DSH `0.1.0-rc.6` 会丢弃
MCP image content，纯文本 DeepSeek 模型仍可获得页面视觉信息。

默认后端是随包提供的 PP-OCRv5 mobile 适配器。Chrome Faithful 不捆绑、
不安装 Python、PaddleOCR、PaddlePaddle、OpenCV、NumPy 或模型权重。用户需
自行安装可选运行时，并显式设置两个本地模型绝对目录，避免 PaddleOCR 回退到
自动下载权重：

```text
CHROME_FAITHFUL_PYTHON=C:\Python311\python.exe
CHROME_FAITHFUL_PPOCR_DET_MODEL_DIR=C:\Models\PP-OCRv5_mobile_det
CHROME_FAITHFUL_PPOCR_REC_MODEL_DIR=C:\Models\PP-OCRv5_mobile_rec
```

`CHROME_FAITHFUL_OCR_BACKEND` 也可设置为无 shell 的
`cli:["executable","arg"]`，或精确的
`http://127.0.0.1:<port>/...` / `http://[::1]:<port>/...` 回环地址。
`CHROME_FAITHFUL_VLM_BACKEND` 使用相同格式且默认关闭，可连接用户自行运行的
SmolVLM2、Moondream 或兼容本地适配器。远程 URL、重定向、自动下载和云端
回退都会被拒绝。OCR 归一化坐标只是现有 `chrome_cua` 的定位提示，不构成
点击授权。

## 快速上手（Windows）

前置：Node.js >= 22.12、Chrome、PowerShell（只有安装器和 `.cmd` 启动器是 Windows 专属；扩展、桥接、MCP 服务均为平台无关）。

```powershell
npm ci --ignore-scripts
```

1. **加载扩展**到每个你想让智能体控制的 Chrome Profile：`chrome://extensions` → 开启*开发者模式* → *加载已解压的扩展程序* → 选择 `extension/`。记下 32 位扩展 ID 和加载的绝对路径。
2. **创建桥接配置**（源码树之外），位于 `%LOCALAPPDATA%\AgentOS\agentos-chrome-cdp\config.json`，以 `config/local.example.json` 作为非机密 schema 参考。密钥必须是生成的 256-bit 值，例如：

   ```powershell
   [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Max 256 }))
   ```

   schema 是闭环的：`host`（必须为 `127.0.0.1`）、`port`、`secret`、`commandTimeoutMs`、`profileAliases`——另有可选桥接/启动器覆盖项。服务端拒绝位于源码树内的配置。
3. **启动桥接**：`npm run bridge`。
4. **向客户端注册 MCP 服务**，让 `node` 指向 `src/mcp-server.mjs` 的绝对路径（或用 `bin\invoke-chrome-cdp.cmd`，它会自动拉起桥接）。仓库内的 `.mcp.json` 使用相对仓库根的路径——Codex 项目配置可用该形式；其他客户端通常需要绝对路径。
5. **验证**：先调 `chrome_profiles`，再 `chrome_selftest`，然后用 `chrome_tabs` 打开/导航标签页。

多 Profile 客户端接线、密钥轮换、DPAPI 加密备份与事务回滚由 PowerShell 安装器自动化：

```powershell
.\scripts\Install-AgentOsChromeExtension.ps1 -Target <已加载扩展的绝对路径>
.\scripts\Install-AgentOsChromeCdp.ps1 -Clients @('CodeBuddy') -ExtensionId $ExtensionId -ExtensionPath $ExtensionPath -ChromeProfileDirectories $ProfileDirs -ChromeUserDataDir $ChromeUserData
```

先不加 `-Apply` 运行——默认就是预览（dry-run）。

## MCP 工具

| 分组 | 工具 |
|---|---|
| Profile 与会话 | `chrome_profiles`、`chrome_profile_catalog`、`chrome_profile_start`、`chrome_selftest`、`chrome_session_v2` |
| 标签页与导航 | `chrome_tabs`、`chrome_session_v2` (finalize)、`chrome_page_event_v2` |
| 交互 | `chrome_playwright_v2`、`chrome_locator`、`chrome_cua`、`chrome_dom_cua_v2` |
| 原始 CDP 与网络 | `chrome_cdp`、`chrome_network_asset_v1` |
| 采集与证据 | `chrome_screenshot`、`chrome_visual_extract`、`chrome_cua_scroll_capture_v1/v2/v3`、`chrome_cua_scroll_capture_status_v1`、`chrome_cua_scroll_asset_capture_start/status/cancel_v2` |
| 资产与内容 | `chrome_page_asset`、`chrome_page_asset_v2`、`chrome_content_v2`（pdf/md/xlsx/csv/docx/pptx） |
| 验证 | `chrome_verification_detect`、`chrome_verification_status`、`chrome_verification_resume`、`chrome_verification_solve`、`chrome_verification_solve_checkbox`、`chrome_verification_solve_slider`、`chrome_verification_capture`、`chrome_verification_dismiss_overlays` |
| 工具类 | `chrome_file_inject`、`chrome_history`、`chrome_clipboard` |

值得注意的行为：定位器调用最多等待 30 秒可见并按 Profile+标签页串行化；`fill` 采用替换语义；`chrome_locator` 接受从零开始的 `index`（`-1` = 最后一个）用于多匹配选择器；截图支持可选文档坐标 `clip` 与绝对 `savePath`，且仍返回 PNG。

## 验证处理

因为 Chrome Faithful 驱动的是你的*真实* Profile，绝大多数机器人检测根本不会触发。当平台仍给出人机验证挑战时，验证模块为智能体提供结构化循环，而不是盲目重试。

**检测**（`chrome_verification_detect`）区分三种真实状态：

| 状态 | 含义 | 动作 |
|---|---|---|
| `resolved` | token 已填充（例如隐形挑战已完成） | 不是阻塞——继续 |
| 活动供应商 iframe（reCAPTCHA v2/v3、hCaptcha、Turnstile、GeeTest、vaptcha） | 存在可见挑战组件 | 求解 |
| `pending-render` | 组件容器存在但挑战 iframe 从未渲染——通常是网络/供应商握手停滞 | 重载重试指引或人工交接 |

静态标记（无处不在的 reCAPTCHA 徽标）被显式排除，因此只*加载*了 reCAPTCHA 的页面绝不会被报为挑战。

**求解**（`chrome_verification_solve`）按类型选策略：

1. **Checkbox / token 等待** —— reCAPTCHA v2 / hCaptcha / Turnstile：点击可见挑战控件（优先 provider iframe 中心），轮询隐藏响应 token 直到填充。
2. **人机化滑块拖拽** —— GeeTest / slider：定位滑块手柄，计算目标（轨道末端或后端缺口偏移），用种子化贝塞尔轨迹（单调 X、抖动、缓入缓出延迟）拖拽，然后验证通过。缺口在手柄后方时 fail-closed，不反向拖拽。
3. **点击优先 generic** —— 文本信号/未知挑战：先点一次明显的 "Verify you are human" / "验证" / "继续" 按钮（或挑战 checkbox），短暂等待 token，只有失败才升级。
4. **capture 送后端** —— 图片选择/音频挑战：保存挑战图片区域和/或音频 URL，提交给外部 OCR/ASR 后端。

**Hold 状态机**（`chrome_verification_status` / `chrome_verification_resume`）—— 每 Profile 的 `idle → challenge_detected → waiting_for_human → cleared`，带可审计、有界的事务日志。`chrome_verification_solve` 成功时清空 hold，失败时交接，求解器崩溃时回滚 hold。

**拟人输入** —— 种子化贝塞尔轨迹 + 抖动、滑块单调 X、缓入缓出时序（`src/verification/input.mjs`），确定性、可测试。

**识别后端是外部且可选的。** 通过 `AGENTOS_VERIFICATION_BACKEND` 环境变量启用，例如 `cli:python scripts/verification/captcha-backend-adapter.py`（面向 Python faster-whisper / OCR / opencv 栈的参考 JSON 适配器；能导入 Agent OS captcha 连接器时优先使用，否则回退到独立 faster-whisper / ddddocr / tesseract / opencv）或 HTTP 端点。没有后端时，检测、hold/resume、交接、遮罩清理、拟人交互全部照常工作。启用后，配置的进程或端点会收到本地捕获路径和/或挑战音频 URL 以及请求动作；HTTP 端点因此可能把挑战数据或凭据带到本项目之外。只配置你信任且获准使用的端点。

设计：[docs/superpowers/specs/2026-08-14-verification-handling-design.md](docs/superpowers/specs/2026-08-14-verification-handling-design.md)

## 实机测试

`scripts/verification/live-tests/` 包含可复现的工具，通过合规桥接通道驱动真实 Chrome Profile（只创建任务标签页，每次运行后关闭）：

- `live-verification-test.mjs [url] [profileName]` —— 针对任意 URL 的通用 检测 → 求解 → 复检 循环。
- `live-cf-test.mjs [profileName]` —— 用 Cloudflare 官方测试 sitekey（`1x00000000000000000000AA` 恒通过、`3x00000000000000000000FF` 强制交互式）加一个点击即过模拟 fixture 测试 Turnstile。先用 `python -m http.server 18999 --directory scripts/verification/live-tests` 提供 fixture。
- `cf-diagnostic-probe.mjs [profileName]` —— 导出组件标记 / iframe / `window.turnstile` 状态，用于排查"组件已渲染但挑战 iframe 缺失"的停滞。
- `final-regression.mjs [profileName]` —— 徽标页不得被检测为挑战；点击即过仍必须可解。

## JavaScript 集成

```js
import { startBridge, createAgent } from "./src/index.mjs";

const bridge = await startBridge();
const agent = createAgent(bridge.router);
const targets = await agent.browsers.list();
const browser = await agent.browsers.get(targets[0].id);
const tab = await browser.tabs.new();
await tab.goto("https://example.com/");
```

## Codex 兼容性

`src/agent-browser.mjs` 实现 Codex 的 `agent.browsers` 接口。parity 被机制化固定：`compat/` 存放本仓库自行编写的功能表面契约、适配映射及其 SHA-256，不再分发已安装产品附带的文档。`npm run check:parity` 与 `test/codex-parity-contract.test.mjs` 在任一契约成员缺失、被 stub 或多余时失败。见 [compat/README.md](compat/README.md) 与 [docs/CODEX_PARITY.md](docs/CODEX_PARITY.md)。

内部标识 `agentos-chrome-cdp`、`AGENTOS_CHROME_CONFIG` 与既有 AgentOS 配置路径为升级兼容而保留；公开显示名称统一为 Chrome Faithful。

## 测试

```text
npm run check          # 静态门禁（结构、JSON 有效性、通用边界）
npm test               # mock/单元测试，含安全契约测试
npm run check:parity   # Codex agent.browsers parity 契约
npm run build:extension
```

安装器事务测试（Windows）：`pwsh -NoProfile -File test/installer-transactions.test.ps1`。

静态检查与 mock 测试必要但不充分。发布验收还要求两个并发连接的真实 Profile、每 Profile `selftest`、后台标签页导航、定位器点击/填写、原始 CDP、截图、历史、带还原的剪贴板往返、页面 File 干注入、重连，以及证明只关闭了验收自有的标签页——由 `scripts/live-acceptance.mjs`、`scripts/differential-acceptance.mjs` 与上面的实机工具驱动。

## 文档

- [SECURITY.md](SECURITY.md) — 安全模型与漏洞上报
- [CONTRIBUTING.md](CONTRIBUTING.md) — 开发流程
- [docs/CODEX_PARITY.md](docs/CODEX_PARITY.md) — Codex parity 设计
- [packages/dsh-plugin-chrome-faithful/](packages/dsh-plugin-chrome-faithful/) — 第一方 DSH bundle
- [docs/superpowers/specs/](docs/superpowers/specs/) — 设计文档（Profile 启动、弹性桥接归属、验证处理）
- [skills/control-chrome-cdp/SKILL.md](skills/control-chrome-cdp/SKILL.md) — 面向智能体的操作技能
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) — 打包的第三方代码

## 状态

实验性。Windows-first：安装器、DPAPI 备份与 `.cmd` 启动器仅限 Windows；扩展、桥接、MCP 服务是平台无关的 Node.js，应该能在任何运行 Chrome 的地方工作，但目前只有 Windows 经过实测。桥接**控制你真实已登录的 Profile**——请审阅安全模型、使用精确 Profile、切勿粘贴你的桥接密钥。

## 许可证

[MIT](LICENSE)。打包的第三方代码为 Apache-2.0（puppeteer-core 浏览器运行时）与 MIT（esbuild）——见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
