import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  VisualBackendError,
  createVisualBackend
} from "../src/visual/backends.mjs";

const fixturePath = fileURLToPath(new URL("./fixtures/visual-backend.mjs", import.meta.url));

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`
  };
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test("CLI backend sends JSON without a shell", async () => {
  const backend = createVisualBackend(`cli:${JSON.stringify([
    process.execPath, fixturePath
  ])}`);
  const result = await backend.request({ action: "ocr", imageBase64: "AA==" });

  assert.deepEqual(result, {
    blocks: [],
    receivedAction: "ocr",
    receivedImage: "AA=="
  });
  assert.equal(backend.shell, false);
});

test("CLI backend treats a non-JSON spec as one executable path", () => {
  const backend = createVisualBackend("cli:C:\\Program Files\\Python311\\python.exe");
  assert.equal(backend.command, "C:\\Program Files\\Python311\\python.exe");
  assert.deepEqual(backend.args, []);
});

test("CLI backend kills a hung child at the deadline", async () => {
  const backend = createVisualBackend(`cli:${JSON.stringify([
    process.execPath, fixturePath, "hang"
  ])}`, { timeoutMs: 100 });
  const started = Date.now();
  await assert.rejects(() => backend.request({ action: "ocr" }), /timed out/);
  assert.ok(Date.now() - started < 2_000);
});

test("CLI backend forcefully terminates a child that ignores graceful shutdown", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "chrome-faithful-visual-"));
  const pidPath = path.join(directory, "pid.txt");
  let pid;
  try {
    const backend = createVisualBackend(`cli:${JSON.stringify([
      process.execPath, fixturePath, "ignore-term", pidPath
    ])}`, { timeoutMs: 100 });
    await assert.rejects(() => backend.request({ action: "ocr" }), /timed out/);
    pid = Number(await readFile(pidPath, "utf8"));
    assert.throws(() => process.kill(pid, 0), /ESRCH|not found|no such process/i);
  } finally {
    if (Number.isInteger(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI backend bounds stdout and never exposes stderr", async () => {
  const oversized = createVisualBackend(`cli:${JSON.stringify([
    process.execPath, fixturePath, "oversize"
  ])}`, { maxResponseBytes: 64 });
  await assert.rejects(() => oversized.request({ action: "ocr" }), /response limit/);

  const failed = createVisualBackend(`cli:${JSON.stringify([
    process.execPath, fixturePath, "stderr-fail"
  ])}`);
  await assert.rejects(() => failed.request({ action: "ocr" }), (error) => {
    assert.ok(error instanceof VisualBackendError);
    assert.match(error.message, /exited unsuccessfully/);
    assert.doesNotMatch(error.message, /super-secret/);
    return true;
  });
});

test("CLI backend redacts synchronous spawn argument failures", async () => {
  for (const spec of [
    `cli:\0SECRET_COMMAND_PATH`,
    `cli:${JSON.stringify([process.execPath, "\0SECRET_ARGUMENT_PATH"])}`
  ]) {
    const backend = createVisualBackend(spec);
    await assert.rejects(() => backend.request({ action: "ocr" }), (error) => {
      assert.ok(error instanceof VisualBackendError);
      assert.equal(error.message, "visual backend could not be started");
      assert.doesNotMatch(error.message, /SECRET|COMMAND|ARGUMENT|PATH/);
      return true;
    });
  }
});

test("HTTP backend rejects non-loopback, TLS, userinfo, and missing ports", () => {
  for (const spec of [
    "https://127.0.0.1:8000/v1",
    "http://vision.example:8000/v1",
    "http://localhost:8000/v1",
    "http://user@127.0.0.1:8000/v1",
    "http://127.0.0.1/v1"
  ]) {
    assert.throws(() => createVisualBackend(spec), /loopback/);
  }
});

test("HTTP backend accepts exact IPv4 and IPv6 loopback URLs", () => {
  const ipv4 = createVisualBackend("http://127.0.0.1:8000/v1");
  const ipv6 = createVisualBackend("http://[::1]:8000/v1");
  assert.equal(ipv4.url.hostname, "127.0.0.1");
  assert.equal(ipv6.url.hostname, "[::1]");
  assert.equal(ipv4.kind, "loopback-http");
  assert.equal(ipv6.kind, "loopback-http");
});

test("PP-OCR backend exposes its bounded local kind", () => {
  const backend = createVisualBackend("ppocr", {
    ppocrCommand: process.execPath,
    ppocrArgs: [fixturePath]
  });
  assert.equal(backend.kind, "ppocrv5-mobile");
});

test("HTTP backend posts JSON and parses a bounded response", async () => {
  const { server, url } = await listen((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ description: JSON.parse(body).prompt }));
    });
  });
  try {
    const result = await createVisualBackend(`${url}/v1`).request({
      action: "semantic",
      prompt: "Describe"
    });
    assert.deepEqual(result, { description: "Describe" });
  } finally {
    await close(server);
  }
});

test("HTTP backend rejects redirects without following them", async () => {
  let redirected = false;
  const { server, url } = await listen((req, res) => {
    if (req.url === "/redirect") {
      res.statusCode = 302;
      res.setHeader("location", "/target");
      res.end();
      return;
    }
    redirected = true;
    res.end("{}");
  });
  try {
    await assert.rejects(
      () => createVisualBackend(`${url}/redirect`).request({ action: "ocr" }),
      /http status 302/
    );
    assert.equal(redirected, false);
  } finally {
    await close(server);
  }
});

test("HTTP backend bounds a chunked response before JSON parsing", async () => {
  const { server, url } = await listen((_req, res) => {
    res.write("{");
    res.write(`"description":"${"x".repeat(128)}`);
    res.end('"}');
  });
  try {
    const backend = createVisualBackend(`${url}/v1`, { maxResponseBytes: 64 });
    await assert.rejects(() => backend.request({ action: "semantic" }), /response limit/);
  } finally {
    await close(server);
  }
});

test("HTTP backend aborts a request at the deadline", async () => {
  const { server, url } = await listen(() => {});
  try {
    const backend = createVisualBackend(`${url}/v1`, { timeoutMs: 100 });
    await assert.rejects(() => backend.request({ action: "ocr" }), /timed out/);
  } finally {
    await close(server);
  }
});
