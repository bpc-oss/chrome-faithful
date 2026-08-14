# 面向 DeepSeek Harness 的 Chrome Faithful

[English](README.md) · **简体中文**

Chrome Faithful 的第一方 DeepSeek Harness（DSH）bundle。它通过 DSH 官方
MCP Client 挂载现有 Chrome Faithful MCP 服务，保留精确 Profile 路由、认证、
脱敏和浏览器控制行为，不把 38 个工具重复实现为原生 Cordis 组件。

## 兼容性

- DSH：`@deepseek-ai/dsh` `0.1.0-rc.6`，或相同且已经复审的 RC 契约
- Node.js：`>=22.12.0`
- Chrome Faithful core：精确使用 `0.4.0`，与本 bundle 版本完全一致

DSH 目前仍处于 RC 阶段，升级到新的 RC 时必须重新验证 bundle。宿主拥有
`@deepseek-ai/dsh-mcp-client`，因此本包不会再安装一份 MCP Client。

## 安装

两个包均公开后，将 bundle 安装到目标 DSH Profile：

```sh
dsh plugin --profile web add @bpc-oss/dsh-plugin-chrome-faithful@0.4.0
```

bundle 会精确锁定 core 版本，因此必须先发布 Chrome Faithful core。私有验收时，
应打包两个本地 tarball，并安装到一次性的 DSH Profile；不要为了验证源码变更而
发布包或修改正在使用的 Profile。

## 配置

按照项目根 README 的说明，在源码树之外创建私有 Chrome Faithful 配置。现有
兼容路径为：

```text
%LOCALAPPDATA%\AgentOS\agentos-chrome-cdp\config.json
```

仅在使用其他绝对路径时设置 `AGENTOS_CHROME_CONFIG`。bundle 只会在该变量
存在时显式传递它，且不内嵌任何密钥。

对于纯文本 DeepSeek 模型，`chrome_visual_extract` 以文字 JSON 返回本地 OCR
文字、置信度和归一化截图坐标。默认适配器要求用户自行安装 PaddleOCR 运行时，
并显式指定本地 PP-OCRv5 mobile 模型目录。

直接生产 MCP 路径（扩展 → 桥接 → MCP 服务 → `chrome_visual_extract`）的
实机 OCR 质量验收已通过：检出 7/7 个文本块，原始字符准确率 99.43%，忽略
空白后准确率 100%。DSH 模型对 `chrome_visual_extract` 输出的消费尚未评测。
可选 VLM 保持关闭，未安装、未评测且未批准。

```text
CHROME_FAITHFUL_PYTHON=C:\Python311\python.exe
CHROME_FAITHFUL_PPOCR_DET_MODEL_DIR=C:\Models\PP-OCRv5_mobile_det
CHROME_FAITHFUL_PPOCR_REC_MODEL_DIR=C:\Models\PP-OCRv5_mobile_rec
```

可选的 `CHROME_FAITHFUL_OCR_BACKEND` 和
`CHROME_FAITHFUL_VLM_BACKEND` 支持无 shell 的 JSON 数组 CLI 规范，例如
`cli:["executable","arg"]`，或带显式端口的精确回环 HTTP URL。未设置时
VLM 路径保持关闭。Chrome Faithful 不安装 Python 包或模型、不下载权重、
不接受远程后端 URL、不跟随重定向，也不会回退到云服务。

bundle 只转发以下六个已定义的字符串值：`AGENTOS_CHROME_CONFIG`、
`CHROME_FAITHFUL_OCR_BACKEND`、`CHROME_FAITHFUL_PYTHON`、
`CHROME_FAITHFUL_PPOCR_DET_MODEL_DIR`、
`CHROME_FAITHFUL_PPOCR_REC_MODEL_DIR` 和
`CHROME_FAITHFUL_VLM_BACKEND`。

激活后，DSH 会暴露带命名空间的工具，例如：

```text
mcp__chrome_faithful__chrome_profiles
mcp__chrome_faithful__chrome_selftest
mcp__chrome_faithful__chrome_cdp
```

MCP 初始启动采用 fail-loud。缺少配置、包无法解析或 MCP 命名空间重复时，
不会静默留下一个没有工具的活动 bundle。

## 安全边界

此集成控制真实、已登录的 Chrome Profile。工具结果对 DSH 中配置的模型和宿主
可见。`chrome_cdp` 的 `action=send` 是不受限的 raw CDP，可以读取已认证页面
内容、Cookie、浏览器存储、token、URL 和 header。只能在完全可信的 DSH
Profile 中安装本 bundle，不要向不可信模型、用户、插件或远程主机开放。

扩展到桥接的连接保留在经过认证的 localhost。启用前请审阅项目的
[安全模型](https://github.com/bpc-oss/chrome-faithful/blob/main/SECURITY.md)。

## 验证状态

仓库测试覆盖 bundle 组合、条件环境变量求值、包隔离、绝对启动器解析和启动
失败行为。一次性 Profile 的 DSH 启动和基线工具调用验收已覆盖视觉工具加入前的
37 个工具；后续直接 MCP 质量验收覆盖了第 38 个工具
`chrome_visual_extract`，但没有评测 DSH 模型消费该结果。每次升级 DSH RC
都必须重新验证这两个边界。
