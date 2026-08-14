import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);
const adapterPath = fileURLToPath(new URL("integrations/ppocr/ppocrv5_mobile.py", root));
const fakeModuleRoot = fileURLToPath(new URL("fixtures/python/", import.meta.url));
const python = process.platform === "win32" ? "python" : "python3";

function pngBase64(width = 1, height = 1) {
  const bytes = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString("base64");
}

async function runPythonAdapter(request, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [adapterPath], {
      env: { ...process.env, ...env },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`adapter exited ${code}: ${stderr}`));
        return;
      }
      resolve({ result: JSON.parse(stdout), stderr });
    });
    child.stdin.end(JSON.stringify(request));
  });
}

async function withModelDirs(run) {
  const directory = await mkdtemp(join(tmpdir(), "chrome-faithful-ppocr-test-"));
  const det = join(directory, "det");
  const rec = join(directory, "rec");
  await mkdir(det);
  await mkdir(rec);
  try {
    return await run({
      CHROME_FAITHFUL_PPOCR_DET_MODEL_DIR: det,
      CHROME_FAITHFUL_PPOCR_REC_MODEL_DIR: rec
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("adapter status never imports or initializes a model", async () => {
  const { result, stderr } = await withModelDirs((modelEnv) => runPythonAdapter(
    { action: "status" },
    {
      ...modelEnv,
      PYTHONPATH: `${fakeModuleRoot}${delimiter}${process.env.PYTHONPATH || ""}`,
      PPOCR_FAKE_FAIL_ON_IMPORT: "1"
    }
  ));
  assert.deepEqual(result, { available: true, backend: "ppocrv5-mobile" });
  assert.equal(stderr, "");
});

test("adapter status reports missing local model directories without downloading", async () => {
  const { result } = await runPythonAdapter({ action: "status" }, {
    PYTHONPATH: `${fakeModuleRoot}${delimiter}${process.env.PYTHONPATH || ""}`,
    CHROME_FAITHFUL_PPOCR_DET_MODEL_DIR: "",
    CHROME_FAITHFUL_PPOCR_REC_MODEL_DIR: ""
  });
  assert.deepEqual(result, {
    available: false,
    backend: "ppocrv5-mobile",
    reason: "local_models_missing"
  });
});

test("adapter converts a fake PaddleOCR v5 prediction", async () => {
  const { result } = await withModelDirs((modelEnv) => runPythonAdapter({
    action: "ocr",
    imageBase64: pngBase64(),
    mimeType: "image/png"
  }, {
    ...modelEnv,
    PYTHONPATH: `${fakeModuleRoot}${delimiter}${process.env.PYTHONPATH || ""}`
  }));
  assert.deepEqual(result, {
    blocks: [{ text: "登录", confidence: 0.98, box: [0, 0, 1, 1] }]
  });
});

test("adapter rejects OCR without explicit local model directories", async () => {
  const { result } = await runPythonAdapter({
    action: "ocr",
    imageBase64: pngBase64(),
    mimeType: "image/png"
  }, {
    PYTHONPATH: `${fakeModuleRoot}${delimiter}${process.env.PYTHONPATH || ""}`,
    CHROME_FAITHFUL_PPOCR_DET_MODEL_DIR: "",
    CHROME_FAITHFUL_PPOCR_REC_MODEL_DIR: ""
  });
  assert.deepEqual(result, {
    error: {
      code: "PPOCR_LOCAL_MODELS_REQUIRED",
      message: "Configure both local PP-OCRv5 mobile model directories."
    }
  });
});

test("adapter rejects malformed image data without reflecting it", async () => {
  const { result } = await withModelDirs((modelEnv) => runPythonAdapter({
    action: "ocr",
    imageBase64: "not-base64",
    mimeType: "image/png"
  }, {
    ...modelEnv,
    PYTHONPATH: `${fakeModuleRoot}${delimiter}${process.env.PYTHONPATH || ""}`
  }));
  assert.deepEqual(result, {
    error: {
      code: "PPOCR_INVALID_IMAGE",
      message: "The OCR request must contain one bounded PNG image."
    }
  });
});
