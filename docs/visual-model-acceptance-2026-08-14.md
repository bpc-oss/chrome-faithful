# PP-OCRv5 mobile live quality acceptance

## Verdict

`PASS` for the default local OCR stage. This does not approve an optional VLM,
which remained disabled and was not installed or evaluated.

## Runtime

- Host: AMD Ryzen 9 9950X3D CPU, no NVIDIA GPU exposed to Windows.
- Python: 3.13.13 in an isolated temporary environment.
- PaddlePaddle: 3.3.1 CPU.
- PaddleOCR: 3.7.0 with PaddleX 3.7.2.
- Models: official `PP-OCRv5_mobile_det` and `PP-OCRv5_mobile_rec` inference
  archives.
- Chrome: Chrome for Testing 152.0.7977.42 in a disposable user-data directory.
- Node: 22.12.0.

Official model archive SHA-256:

- detector: `50446e5d01ac2a73d5319c89513281f6578414c888c602f9af13f93feefffc58`
- recognizer: `566b9512b34e34a9f0db54d87b51fa5a0b9ed2cf1ab7e49728cc0b8b5a64f414`

## Production-path evidence

The acceptance launched the real unpacked Chrome Faithful extension in a
disposable Chrome profile, registered it through a one-use bootstrap token
against a disposable bridge, connected the real MCP server, observed all 38
tools, created an exact-profile tab, rendered the controlled corpus, and
called `chrome_visual_extract` three times. Remote debugging was used only to
discover the temporary unpacked extension ID and open its bootstrap page; the
screenshot and OCR call used the Chrome Faithful extension/bridge/MCP path.
The existing Chrome sessions and port 18755 service were not used.

The corpus included Chinese, English, identifiers, punctuation, currency,
decimal coordinates, 16 px small text, and low-contrast text:

- expected blocks: 7
- detected blocks: 7
- exact lines after Unicode normalization: 6/7
- raw character accuracy: 99.43%
- non-whitespace character accuracy: 100%
- mean confidence: 0.9754
- minimum confidence: 0.9379
- normalized coordinate bounds valid: yes
- reading order valid: yes
- three-run image hash and OCR output stability: identical
- end-to-end call latency: 3233 ms, 2996 ms, 3245 ms

The sole text difference was a removed layout space:
`DeepSeek 可以读取网页文字。` became `DeepSeek可以读取网页文字。`. No
non-whitespace character was lost or changed.

## Compatibility finding and disposition

With PaddlePaddle 3.3.1's default oneDNN path on this AMD CPU, the official
model failed before producing OCR output with
`ConvertPirAttribute2RuntimeAttribute` unsupported for a PIR double-array
attribute. Holding the runtime, models, and image constant while setting
`enable_mkldnn=False` made inference succeed. The adapter now explicitly uses
that portable CPU setting, and the regression fixture requires it.

## Acceptance thresholds

- all seven blocks detected;
- raw character accuracy at least 99%;
- non-whitespace character accuracy 100%;
- confidence values and normalized bounds valid;
- reading order valid;
- three repeated production-path calls stable.

All thresholds passed. Temporary Python packages, model weights, Chrome
runtime, screenshots, bridge configuration, tokens, and profiles are not
repository artifacts and are removed during closeout.
