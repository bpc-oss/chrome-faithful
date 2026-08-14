# PP-OCRv5 mobile adapter

This optional adapter reads one JSON request from stdin and writes one JSON
response to stdout. Chrome Faithful ships the adapter, not Python,
PaddlePaddle, PaddleOCR, OpenCV, NumPy, model weights, or a Python environment.

Install a compatible PaddleOCR 3.x runtime yourself and obtain the
`PP-OCRv5_mobile_det` and `PP-OCRv5_mobile_rec` inference models under their
applicable terms. Then set absolute local directories:

```text
CHROME_FAITHFUL_PPOCR_DET_MODEL_DIR=/absolute/path/to/PP-OCRv5_mobile_det
CHROME_FAITHFUL_PPOCR_REC_MODEL_DIR=/absolute/path/to/PP-OCRv5_mobile_rec
```

Set `CHROME_FAITHFUL_PYTHON` when the desired Python executable is not the
platform default. The adapter passes both directories explicitly to
`PaddleOCR`; it never asks PaddleOCR to resolve a model by name alone, runs a
package installer, downloads weights, writes screenshots, or calls a remote
API. Missing dependencies or directories produce a bounded error response.

Status request:

```json
{"action":"status"}
```

OCR request:

```json
{"action":"ocr","imageBase64":"<bounded PNG>","mimeType":"image/png"}
```

Successful OCR response:

```json
{"blocks":[{"text":"登录","confidence":0.98,"box":[20,10,120,40]}]}
```

The box is in screenshot pixels. Chrome Faithful validates it and converts it
to normalized coordinates before returning it to an MCP client.
