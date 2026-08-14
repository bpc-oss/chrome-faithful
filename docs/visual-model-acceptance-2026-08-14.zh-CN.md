# PP-OCRv5 mobile 实机质量验收

[English](visual-model-acceptance-2026-08-14.md) · **简体中文**

## 结论

默认本地 OCR 阶段为 `PASS`。可选 VLM 未批准；验收期间保持关闭，且未安装、
未评测。

## 运行环境

- 主机：AMD Ryzen 9 9950X3D CPU；Windows 未暴露 NVIDIA GPU。
- Python：隔离临时环境中的 3.13.13。
- PaddlePaddle：3.3.1 CPU。
- PaddleOCR：3.7.0，配合 PaddleX 3.7.2。
- 模型：官方 `PP-OCRv5_mobile_det` 与 `PP-OCRv5_mobile_rec` 推理归档。
- Chrome：一次性用户数据目录中的 Chrome for Testing 152.0.7977.42。
- Node：22.12.0。

官方模型归档 SHA-256：

- 检测模型：`50446e5d01ac2a73d5319c89513281f6578414c888c602f9af13f93feefffc58`
- 识别模型：`566b9512b34e34a9f0db54d87b51fa5a0b9ed2cf1ab7e49728cc0b8b5a64f414`

## 生产路径证据

验收在一次性 Chrome Profile 中启动真实的未打包 Chrome Faithful 扩展，使用
一次性 bootstrap token 注册到一次性桥接，连接真实 MCP 服务，观察到全部
38 个工具，创建精确 Profile 标签页，渲染受控语料，并连续三次调用
`chrome_visual_extract`。远程调试只用于发现临时未打包扩展 ID 和打开其
bootstrap 页面；截图与 OCR 调用经过 Chrome Faithful 扩展、桥接和 MCP 路径。
既有 Chrome 会话和 18755 端口服务均未使用。

语料包含中文、英文、标识符、标点、货币、十进制坐标、16 px 小字和低对比度
文字：

- 预期文本块：7
- 检出文本块：7/7
- Unicode 归一化后完全一致的文本行：6/7
- 原始字符准确率：99.43%
- 忽略空白后的字符准确率：100%
- 平均置信度：0.9754
- 最低置信度：0.9379
- 归一化坐标边界有效：是
- 阅读顺序有效：是
- 三次图像哈希和 OCR 输出稳定性：完全一致
- 端到端调用耗时：3233 ms、2996 ms、3245 ms

唯一文本差异是删除了一个布局空格：`DeepSeek 可以读取网页文字。` 被识别为
`DeepSeek可以读取网页文字。`。没有非空白字符丢失或改变。

## 兼容性发现与处理

在这台 AMD CPU 上，PaddlePaddle 3.3.1 的默认 oneDNN 路径在生成 OCR 输出前
失败，原因是 PIR double-array 属性不支持
`ConvertPirAttribute2RuntimeAttribute`。保持运行时、模型和图像不变，仅设置
`enable_mkldnn=False` 后推理成功。适配器现已显式采用这一可移植 CPU 设置，
回归 fixture 也强制要求该设置。

## 验收阈值

- 七个文本块全部检出；
- 原始字符准确率至少 99%；
- 忽略空白后的字符准确率为 100%；
- 置信度和归一化坐标边界有效；
- 阅读顺序有效；
- 连续三次生产路径调用保持稳定。

全部阈值均已通过。临时 Python 包、模型权重、Chrome 运行时、截图、桥接配置、
token 和 Profile 均不是仓库制品，并已在收口时删除。
