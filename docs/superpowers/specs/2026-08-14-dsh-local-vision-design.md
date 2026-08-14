# DSH Local Vision Design

**Status:** Approved by the user

**Date:** 2026-08-14

## Goal

Give text-only DeepSeek models in DSH a small, local-first visual bridge for
Chrome pages. The first stage turns an exact-profile screenshot into bounded
OCR text, confidence, and normalized coordinates. A second, optional adapter
can add semantic descriptions from a user-operated local vision-language
model (VLM).

## Why a text bridge is required

Chrome Faithful already captures viewport, clipped, element, and full-page
screenshots. DSH `0.1.0-rc.6` currently discards MCP image content while
extracting text, so returning another image block does not give a text-only
DeepSeek model useful visual context. The new tool therefore returns a compact
text/JSON projection that DSH preserves.

## Product boundary

Add one MCP tool, `chrome_visual_extract`, to the provider-neutral core. It
reuses the existing exact-profile tab and screenshot path; it does not add a
browser, debug port, copied profile, second bridge, or DSH-specific browser
implementation.

The default policy is local OCR. The shipped PP-OCRv5 mobile adapter is an
optional Python integration: Chrome Faithful ships the adapter and protocol,
not Python, PaddlePaddle, PaddleOCR, or model weights. Missing runtime or model
dependencies fail with an actionable error and never trigger an automatic
download or installation.

The VLM path is disabled unless the user configures it. It accepts only a
local CLI process or an exact loopback HTTP endpoint. The first release does
not send screenshots to a cloud API and does not accept arbitrary remote URLs.
Users own the model runtime and may choose SmolVLM2 500M/2.2B, Moondream
0.5B/2B, or another backend that implements the documented protocol.

## Tool contract

`chrome_visual_extract` accepts:

- `profileName` and `tabId`, both required and resolved through the existing
  exact-profile browser path;
- `mode`: `ocr` (default), `semantic`, or `both`;
- optional `clip` using the existing screenshot coordinate contract;
- `fullPage`, default `false` and mutually exclusive with `clip`;
- optional `prompt`, accepted only for `semantic` or `both`, with a small
  bounded length.

The result is text content containing JSON with:

- image width and height plus a SHA-256 digest, but no filesystem path or
  base64 image;
- OCR blocks containing bounded text, confidence from `0` to `1`, and
  normalized `x`, `y`, `width`, and `height` coordinates from `0` to `1`;
- an optional bounded semantic description;
- backend kind and explicit partial/error state when one requested stage is
  unavailable.

Output is capped by block count, per-block text length, description length,
and total serialized bytes. Invalid backend output fails closed instead of
being reflected into MCP results.

## Backend protocol

Backends receive one JSON request containing the action, PNG bytes as base64,
image MIME type, dimensions, and the optional prompt. The CLI transport writes
one request to stdin and reads one JSON response from stdout without a shell.
The HTTP transport permits only `http://127.0.0.1:<port>/...` or
`http://[::1]:<port>/...`, uses a hard timeout, and accepts no response larger
than the configured cap.

The PP-OCRv5 mobile adapter implements the OCR response schema. It imports
PaddleOCR only when an OCR request arrives, disables document-orientation,
unwarping, and text-line-orientation helpers by default, and returns detected
text, confidence, and pixel-space boxes for normalization in Node.js. A status
request reports missing dependencies without downloading them.

Configuration uses explicit environment variables so the existing private
bridge configuration and installer schema remain stable:

- `CHROME_FAITHFUL_OCR_BACKEND`: absent means the shipped PP-OCRv5 mobile
  adapter through the configured/default Python command; `cli:...` or an exact
  loopback URL selects another local OCR backend;
- `CHROME_FAITHFUL_PYTHON`: optional Python executable for the shipped adapter;
- `CHROME_FAITHFUL_PPOCR_DET_MODEL_DIR`: required absolute local directory for
  the `PP-OCRv5_mobile_det` inference model;
- `CHROME_FAITHFUL_PPOCR_REC_MODEL_DIR`: required absolute local directory for
  the `PP-OCRv5_mobile_rec` inference model;
- `CHROME_FAITHFUL_VLM_BACKEND`: absent means disabled; `cli:...` or an exact
  loopback URL enables semantic extraction.

Both PP-OCR model directories are passed explicitly to PaddleOCR. The adapter
fails closed before constructing the pipeline when either directory is absent,
so PaddleOCR never receives a model-name-only request that could download
weights automatically.

The DSH bundle passes through only these named variables when present. It does
not copy the whole parent environment.

## Privacy and safety

Authenticated screenshots can contain messages, account data, tokens rendered
in the page, or other sensitive information. Therefore:

- OCR is local by default and the VLM adapter is local-only;
- no screenshot is captured in the background or without an explicit tool
  call;
- viewport capture is the default; full-page and clipped capture are explicit;
- the PNG is piped in memory and is not written to a temporary file by the
  core;
- results do not include image bytes, local paths, raw backend diagnostics, or
  environment values;
- hard timeouts, input pixel limits, output caps, and child termination bound
  resource use;
- visual coordinates are hints for existing CUA calls, not proof that an
  action is safe or that a challenge was solved.

## Testing

Automated tests must prove:

1. OCR result validation normalizes pixel boxes and rejects NaN, out-of-range
   confidence, oversized text, excessive blocks, and unknown keys.
2. CLI transport does not use a shell, bounds stdin/stdout and time, kills a
   hung child, and redacts stderr from public errors.
3. HTTP transport accepts only exact loopback hosts, rejects userinfo and
   redirects, bounds response size, and times out.
4. The PP-OCR adapter status path works without PaddleOCR installed and the
   protocol parser can be exercised with a fake PaddleOCR module without model
   downloads.
5. The MCP tool reuses the requested exact-profile tab, rejects `clip` plus
   `fullPage`, defaults to viewport OCR, and returns text-only content.
6. Semantic extraction is unavailable until explicitly configured; `both`
   reports a bounded partial result if OCR succeeds and the VLM stage fails.
7. The DSH patch evaluates all six pass-through branches and keeps string-only
   environment values.
8. Release manifests, tool inventories, package allowlists, bilingual docs,
   and third-party disclosures stay synchronized.
9. Existing Node, parity, deterministic-extension, DSH host/isolation, and
   Windows installer transaction gates remain green.

An optional live gate may use a disposable profile and a user-authorized local
PP-OCR installation. Absence of the optional Python/model dependency must be
reported as unverified, not silently replaced with a cloud service.

## Acceptance criteria

- A text-only DSH model can call `chrome_visual_extract` and receive bounded
  OCR text with coordinates from the exact requested Chrome tab.
- Default behavior never uploads the screenshot and never auto-installs a
  runtime or model.
- Local VLM support is opt-in, backend-neutral, and disabled when unconfigured.
- Existing screenshot, browser-control, DSH bundle, and generic MCP clients
  keep their current behavior.
- Automated tests and independent review find no unresolved critical or high
  issue.
