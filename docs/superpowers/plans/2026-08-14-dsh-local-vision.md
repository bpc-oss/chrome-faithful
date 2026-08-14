# DSH Local Vision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local-first `chrome_visual_extract` MCP tool that converts an exact-profile Chrome screenshot into bounded OCR text and coordinates, with an opt-in local VLM description stage.

**Architecture:** The MCP server reuses the existing screenshot path and passes PNG bytes in memory to a new local-only backend layer. A shipped Python adapter provides the default PP-OCRv5 mobile protocol without bundling Python, PaddleOCR, PaddlePaddle, or model weights; an optional CLI or exact-loopback backend provides VLM descriptions. All backend output is validated and converted to text-only JSON for DSH.

**Tech Stack:** Node.js `>=22.12.0`, MCP SDK, Node built-ins, Python 3 optional adapter, PaddleOCR/PP-OCRv5 mobile optional runtime, Node test runner.

## Global Constraints

- Reuse the existing exact-profile tab and screenshot implementation; do not add a browser, debug port, copied profile, or second bridge.
- Default OCR is local PP-OCRv5 mobile; never auto-install Python, packages, or model weights.
- VLM is disabled by default and may use only a shell-free CLI or exact `127.0.0.1`/`::1` HTTP endpoint.
- Never return screenshot bytes, local paths, environment values, backend stderr, or raw invalid backend output to MCP.
- Default to viewport capture; `fullPage` and `clip` are explicit and mutually exclusive.
- Cap input pixels, child/runtime duration, backend response bytes, OCR blocks, text lengths, and final serialized output.
- Keep existing generic MCP, DSH, screenshot, installer, and exact-profile behavior compatible.

---

### Task 1: Strict visual result and PNG contracts

**Files:**
- Create: `src/visual/png.mjs`
- Create: `src/visual/result.mjs`
- Create: `test/visual-result.test.mjs`

**Interfaces:**
- Produces: `readPngDimensions(png: Uint8Array) -> { width, height }`.
- Produces: `normalizeVisualResult(raw, { width, height, mode }) -> { ocr?, semantic?, partial? }`.
- Produces: constants for maximum pixels, blocks, block text, description text, and result bytes.

- [ ] **Step 1: Write failing PNG and normalization tests**

```js
test("normalizes PP-OCR pixel boxes to unit coordinates", () => {
  const result = normalizeVisualResult({
    blocks: [{ text: "登录", confidence: 0.98, box: [20, 10, 120, 40] }]
  }, { width: 200, height: 100, mode: "ocr" });
  assert.deepEqual(result.ocr.blocks[0].bounds, {
    x: 0.1, y: 0.1, width: 0.5, height: 0.3
  });
});

test("rejects invalid or excessive backend output", () => {
  assert.throws(() => normalizeVisualResult({
    blocks: [{ text: "x", confidence: Number.NaN, box: [0, 0, 1, 1] }]
  }, { width: 1, height: 1, mode: "ocr" }), /invalid visual backend output/);
});
```

- [ ] **Step 2: Run the focused test and confirm the missing-module failure**

Run: `npx --yes node@22.12.0 --test test/visual-result.test.mjs`

Expected: FAIL because `src/visual/png.mjs` and `src/visual/result.mjs` do not exist.

- [ ] **Step 3: Implement strict parsing and bounds**

```js
export function readPngDimensions(bytes) {
  const png = Buffer.from(bytes);
  if (png.length < 24 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("visual capture did not return a valid PNG");
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width < 1 || height < 1 || width * height > MAX_VISUAL_PIXELS) {
    throw new Error("visual capture exceeds the supported pixel limit");
  }
  return { width, height };
}
```

Implement closed-key validation, finite numeric checks, rectangle clamping,
unit-coordinate rounding, and final JSON byte counting in `result.mjs`. Accept
only `{ blocks }` for OCR and `{ description }` for semantic output.

- [ ] **Step 4: Run focused tests**

Run: `npx --yes node@22.12.0 --test test/visual-result.test.mjs`

Expected: all visual result tests pass with no skipped tests.

- [ ] **Step 5: Commit**

```bash
git add src/visual/png.mjs src/visual/result.mjs test/visual-result.test.mjs
git commit -m "feat: validate bounded visual results"
```

### Task 2: Local-only CLI and loopback backend transports

**Files:**
- Create: `src/visual/backends.mjs`
- Create: `test/visual-backends.test.mjs`
- Create: `test/fixtures/visual-backend.mjs`

**Interfaces:**
- Consumes: Task 1 output byte limits.
- Produces: `createVisualBackend(spec, options) -> VisualBackend | null`.
- Produces: `VisualBackend.request(payload) -> Promise<object>`.
- Backend spec: `ppocr`, `cli:<executable>`, `cli:["executable","arg"]`, or exact loopback HTTP URL.

- [ ] **Step 1: Write failing transport tests**

```js
test("CLI backend sends JSON without a shell", async () => {
  const backend = createVisualBackend(`cli:${JSON.stringify([
    process.execPath, fixturePath
  ])}`);
  const result = await backend.request({ action: "ocr", imageBase64: "AA==" });
  assert.deepEqual(result, { blocks: [] });
  assert.equal(backend.shell, false);
});

test("HTTP backend rejects non-loopback and userinfo URLs", () => {
  assert.throws(() => createVisualBackend("https://vision.example/v1"), /loopback/);
  assert.throws(() => createVisualBackend("http://user@127.0.0.1:8000"), /userinfo/);
});
```

Also test timeout termination, bounded stdout, generic public errors without
stderr, `redirect: "manual"`, exact IPv4/IPv6 loopback acceptance, and an
oversized HTTP response streamed in chunks.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npx --yes node@22.12.0 --test test/visual-backends.test.mjs`

Expected: FAIL because the backend module does not exist.

- [ ] **Step 3: Implement transports with hard limits**

```js
const child = spawn(command, args, {
  shell: false,
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"]
});
```

Collect stdout as bytes and terminate the child when the response cap or
timeout is exceeded. Do not include stderr in thrown messages. For HTTP, parse
with `new URL`, require `http:`, empty username/password, an explicit port,
hostname exactly `127.0.0.1` or `[::1]`, and `redirect: "manual"`. Read the
response stream with a byte counter before parsing JSON.

- [ ] **Step 4: Run focused tests**

Run: `npx --yes node@22.12.0 --test test/visual-backends.test.mjs`

Expected: all transport tests pass with no skipped tests.

- [ ] **Step 5: Commit**

```bash
git add src/visual/backends.mjs test/visual-backends.test.mjs test/fixtures/visual-backend.mjs
git commit -m "feat: add local visual backend transports"
```

### Task 3: Shipped PP-OCRv5 mobile adapter

**Files:**
- Create: `integrations/ppocr/ppocrv5_mobile.py`
- Create: `integrations/ppocr/README.md`
- Create: `test/ppocr-adapter.test.mjs`
- Create: `test/fixtures/python/paddleocr/__init__.py`
- Modify: `package.json`
- Modify: `THIRD_PARTY_NOTICES.md`

**Interfaces:**
- Consumes: CLI JSON request `{ action, imageBase64, mimeType }`.
- Produces: status `{ available, backend: "ppocrv5-mobile", reason? }`.
- Produces: OCR `{ blocks: [{ text, confidence, box: [x1,y1,x2,y2] }] }`.

- [ ] **Step 1: Write failing adapter protocol tests**

```js
test("adapter status never downloads or initializes a model", async () => {
  const result = await runPythonAdapter({ action: "status" });
  assert.equal(result.backend, "ppocrv5-mobile");
  assert.equal(typeof result.available, "boolean");
});

test("adapter converts a fake PaddleOCR prediction", async () => {
  const result = await runPythonAdapter({
    action: "ocr", imageBase64: onePixelPngBase64, mimeType: "image/png"
  }, { PYTHONPATH: fakeModuleRoot });
  assert.deepEqual(result.blocks[0], {
    text: "登录", confidence: 0.98, box: [0, 0, 1, 1]
  });
});
```

- [ ] **Step 2: Run adapter tests and confirm failure**

Run: `npx --yes node@22.12.0 --test test/ppocr-adapter.test.mjs`

Expected: FAIL because the adapter is absent.

- [ ] **Step 3: Implement the stdio adapter**

```python
def handle(request):
    if request.get("action") == "status":
        return status_without_model_initialization()
    if request.get("action") != "ocr":
        raise ProtocolError("unsupported action")
    image = decode_bounded_png(request)
    from paddleocr import PaddleOCR
    engine = PaddleOCR(
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
    )
    return convert_predictions(engine.predict(input=image))
```

Read exactly one bounded JSON request, decode only PNG, write exactly one JSON
response, and emit bounded generic error codes. Do not invoke pip, download
commands, shell commands, or remote APIs. Add `integrations/ppocr/` to the npm
`files` allowlist. Document that PaddleOCR and model weights are optional,
user-installed Apache-2.0 components; add a notice entry without claiming they
are bundled dependencies.

- [ ] **Step 4: Run adapter and package tests**

Run: `npx --yes node@22.12.0 --test test/ppocr-adapter.test.mjs test/release-contract.test.mjs`

Expected: all tests pass; `npm pack --dry-run --json` contains the adapter and
README but no Python environment, cache, model, or weight file.

- [ ] **Step 5: Commit**

```bash
git add integrations/ppocr package.json THIRD_PARTY_NOTICES.md test/ppocr-adapter.test.mjs test/fixtures/python
git commit -m "feat: ship PP-OCRv5 mobile adapter"
```

### Task 4: Visual extraction orchestration and MCP tool

**Files:**
- Create: `src/visual/extract.mjs`
- Create: `test/visual-extract.test.mjs`
- Modify: `src/mcp-server.mjs`
- Modify: `test/release-contract.test.mjs`
- Modify: `mcpb/manifest.json`

**Interfaces:**
- Consumes: `readPngDimensions`, `createVisualBackend`, and `normalizeVisualResult`.
- Produces: `runVisualExtract({ screenshot, mode, clip, fullPage, prompt, ocrBackend, vlmBackend })`.
- Produces: MCP tool `chrome_visual_extract` returning text-only JSON content.

- [ ] **Step 1: Write failing orchestration tests**

```js
test("defaults to viewport OCR and returns normalized text-only output", async () => {
  const result = await runVisualExtract({
    screenshot: async (options) => {
      assert.deepEqual(options, { fullPage: false, clip: undefined });
      return pngFixture;
    },
    mode: "ocr",
    ocrBackend: fakeOcrBackend
  });
  assert.equal(result.ocr.blocks[0].text, "登录");
});

test("rejects clip plus fullPage before capturing", async () => {
  await assert.rejects(() => runVisualExtract({
    screenshot: failIfCalled, mode: "ocr", clip, fullPage: true,
    ocrBackend: fakeOcrBackend
  }), /mutually exclusive/);
});
```

Test missing VLM behavior, `both` partial output after OCR success, prompt-mode
rules, screenshot SHA-256, and absence of image/path/base64 fields.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npx --yes node@22.12.0 --test test/visual-extract.test.mjs`

Expected: FAIL because the orchestration module and MCP schema are absent.

- [ ] **Step 3: Implement orchestration and register the tool**

```js
const bytes = Buffer.from(await screenshot({ fullPage, clip }));
const { width, height } = readPngDimensions(bytes);
const payload = {
  imageBase64: bytes.toString("base64"),
  mimeType: "image/png",
  width,
  height
};
```

Construct the default PP-OCR backend from the shipped adapter and
`CHROME_FAITHFUL_PYTHON`; parse custom OCR/VLM specs only once at startup. Add
the MCP schema beside `chrome_screenshot`, resolve the exact profile/tab in the
handler, call `runVisualExtract`, and return only `textResult(result)`.

- [ ] **Step 4: Synchronize tool inventories and run focused tests**

Update `mcpb/manifest.json` and release-contract expectations from 37 to 38
tools. Run:

`npx --yes node@22.12.0 --test test/visual-result.test.mjs test/visual-backends.test.mjs test/visual-extract.test.mjs test/release-contract.test.mjs`

Expected: all focused tests pass and the MCPB tool list equals the server list.

- [ ] **Step 5: Commit**

```bash
git add src/visual src/mcp-server.mjs test/visual-extract.test.mjs test/release-contract.test.mjs mcpb/manifest.json
git commit -m "feat: expose local visual extraction tool"
```

### Task 5: DSH environment pass-through and user documentation

**Files:**
- Modify: `packages/dsh-plugin-chrome-faithful/cordis.patch.yml`
- Modify: `test/dsh-bundle-contract.test.mjs`
- Modify: `test/dsh-host-contract.test.mjs`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `packages/dsh-plugin-chrome-faithful/README.md`
- Modify: `SECURITY.md`

**Interfaces:**
- Consumes: the three named visual environment variables.
- Produces: a DSH MCP client `config.env` object containing only defined,
  string-valued allowlisted variables.

- [ ] **Step 1: Extend the real DSH expression tests first**

```js
assert.deepEqual(evaluateEnv({
  CHROME_FAITHFUL_PYTHON: "C:\\\\Python311\\\\python.exe",
  CHROME_FAITHFUL_VLM_BACKEND: "http://127.0.0.1:18080/v1"
}), {
  CHROME_FAITHFUL_PYTHON: "C:\\\\Python311\\\\python.exe",
  CHROME_FAITHFUL_VLM_BACKEND: "http://127.0.0.1:18080/v1"
});
```

Test all variables absent, one present, all present, and a non-string value
excluded through DSH's actual YAML expression evaluation plus MCP-client
schema path.

- [ ] **Step 2: Run DSH contract tests and confirm failure**

Run: `npx --yes node@22.12.0 --test test/dsh-bundle-contract.test.mjs test/dsh-host-contract.test.mjs`

Expected: FAIL because the bundle does not pass the visual variables.

- [ ] **Step 3: Update the allowlisted environment expression**

```yaml
env: !!js "Object.fromEntries(['AGENTOS_CHROME_CONFIG', 'CHROME_FAITHFUL_OCR_BACKEND', 'CHROME_FAITHFUL_PYTHON', 'CHROME_FAITHFUL_VLM_BACKEND'].flatMap((key) => typeof process.env[key] === 'string' ? [[key, process.env[key]]] : []))"
```

Document PP-OCR prerequisites, local-only backend formats, text-only DSH
behavior, coordinate use with existing CUA tools, model non-bundling, privacy
limits, and actionable missing-runtime errors in English and Chinese.

- [ ] **Step 4: Run DSH and documentation gates**

Run: `npx --yes node@22.12.0 --test test/dsh-bundle-contract.test.mjs test/dsh-host-contract.test.mjs test/release-contract.test.mjs`

Expected: all tests pass with both environment branches evaluated by the
published DSH host path.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-chrome-faithful README.md README.zh-CN.md SECURITY.md test/dsh-bundle-contract.test.mjs test/dsh-host-contract.test.mjs test/release-contract.test.mjs
git commit -m "docs: add local vision setup for DSH"
```

### Task 6: Full verification, optional live OCR evidence, and review

**Files:**
- Modify: `HANDOFF.md`
- Keep untracked/private: `.agent-os/`, `docs/agent-lessons.md`, live receipts,
  Python environments, model caches, screenshots.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: verified release evidence and a concise handoff.

- [ ] **Step 1: Run the full Node and generation gates on the declared runtime**

```bash
npx --yes node@22.12.0 scripts/run-unit-tests.mjs
npx --yes node@22.12.0 scripts/check.mjs
npx --yes node@22.12.0 scripts/check-codex-parity.mjs
npx --yes node@22.12.0 scripts/build-extension-runtime.mjs
git diff --exit-code -- extension/generated/
```

Expected: zero failures/skips, `CHECK_OK`, parity success, and no generated
runtime diff.

- [ ] **Step 2: Run Windows installer transactions in both hosts**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\test\installer-transactions.test.ps1
pwsh.exe -NoProfile -File .\test\installer-transactions.test.ps1
```

Expected: both return `status: PASS`, production guard unchanged.

- [ ] **Step 3: Inspect optional local OCR prerequisites without installing**

Run status through the shipped adapter using the selected Windows Python. If
PaddleOCR and the PP-OCRv5 mobile model already exist, run one disposable tab
fixture and verify Chinese text plus coordinates. If absent, record
`OPTIONAL_LIVE_OCR_UNVERIFIED_MISSING_DEPENDENCY`; do not install or download
without separate user authority and do not substitute a cloud backend.

- [ ] **Step 4: Run GitHub CI on the pushed commit**

Push only tracked intended files, then inspect both Ubuntu and Windows jobs.
Expected: DSH host/isolation, full Node suite, build/diff, and Windows installer
transactions all succeed.

- [ ] **Step 5: Request independent security/correctness review**

Reviewer must inspect the actual diff, local-only URL enforcement, process
spawning, bounds, result redaction, package contents, docs, tests, and CI. Fix
or explicitly disposition every finding before closeout.

- [ ] **Step 6: Update handoff and commit closeout**

Record goals, changed files, exact commands/results, optional OCR live status,
CI URL, review verdict, residual model-quality risk, and the fact that the
repository remains private. Never stage `.agent-os/` or
`docs/agent-lessons.md`.

```bash
git add HANDOFF.md
git commit -m "docs: close out local vision bridge"
```
