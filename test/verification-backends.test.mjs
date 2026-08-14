import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { CliBackend, HttpBackend, createBackend, createBackendFromEnv, SolverBackendError } from "../src/verification/solvers/backends.mjs";

test("cli backend spawns a command, sends JSON, and parses JSON stdout", async () => {
  const script = "process.stdin.on('data',(d)=>{const p=JSON.parse(d);process.stdout.write(JSON.stringify({text:p.action==='status'?'ok':'noop'}));}).on('end',()=>process.exit(0));";
  const backend = new CliBackend({ command: "node", args: ["-e", script], timeoutMs: 5000 });
  const result = await backend.status();
  assert.equal(result.text, "ok");
});

test("cli backend surfaces non-zero exit as SolverBackendError", async () => {
  const backend = new CliBackend({ command: "node", args: ["-e", "process.stderr.write('kaput');process.exit(3);"], timeoutMs: 5000 });
  await assert.rejects(() => backend.status(), (error) => {
    assert.ok(error instanceof SolverBackendError);
    assert.match(error.message, /kaput/);
    return true;
  });
});

test("cli backend surfaces spawn ENOENT as SolverBackendError", async () => {
  const backend = new CliBackend({ command: "definitely-not-a-real-binary-xyz", args: [], timeoutMs: 3000 });
  await assert.rejects(() => backend.status(), (error) => {
    assert.ok(error instanceof SolverBackendError);
    assert.match(error.message, /spawn failed/);
    return true;
  });
});

test("cli backend kills a hung child and reports a timeout", async () => {
  const backend = new CliBackend({ command: "node", args: ["-e", "setTimeout(()=>{}, 5000)"], timeoutMs: 800 });
  const started = Date.now();
  await assert.rejects(() => backend.status(), (error) => {
    assert.ok(error instanceof SolverBackendError);
    assert.match(error.message, /timed out/);
    return true;
  });
  assert.ok(Date.now() - started < 4000, "timeout must fire before the child finishes");
});

test("cli backend falls back to raw stdout when the output is not JSON", async () => {
  const backend = new CliBackend({ command: "node", args: ["-e", "process.stdout.write('just text')"], timeoutMs: 3000 });
  const result = await backend.status();
  assert.equal(result.raw, true);
  assert.equal(result.text, "just text");
});

test("http backend posts JSON and parses the response", async () => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const payload = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ action: payload.action, text: "hello" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const backend = new HttpBackend({ url: `http://127.0.0.1:${port}`, timeoutMs: 5000 });
    const result = await backend.solveImage({ imagePath: "C:\\tmp\\cap.png" });
    assert.equal(result.action, "solve-image");
    assert.equal(result.text, "hello");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("http backend surfaces non-OK status as SolverBackendError", async () => {
  const server = createServer((_req, res) => {
    res.statusCode = 500;
    res.end("boom");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const backend = new HttpBackend({ url: `http://127.0.0.1:${port}`, timeoutMs: 5000 });
    await assert.rejects(() => backend.solveImage({ imagePath: "C:\\tmp\\cap.png" }), (error) => {
      assert.ok(error instanceof SolverBackendError);
      assert.match(error.message, /http 500/);
      return true;
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("createBackend returns null for empty config", () => {
  assert.equal(createBackend(null), null);
  assert.equal(createBackendFromEnv(""), null);
  assert.equal(createBackendFromEnv(undefined), null);
});

test("createBackendFromEnv parses cli: and bare command forms", () => {
  const cli = createBackendFromEnv("cli:python scripts/verification/captcha-backend-adapter.py");
  assert.ok(cli instanceof CliBackend);
  assert.equal(cli.command, "python");
  assert.deepEqual(cli.args, ["scripts/verification/captcha-backend-adapter.py"]);

  const bare = createBackendFromEnv("node solver.mjs");
  assert.ok(bare instanceof CliBackend);
  assert.equal(bare.command, "node");
});

test("createBackendFromEnv parses http URLs", () => {
  const http = createBackendFromEnv("http://127.0.0.1:18001");
  assert.ok(http instanceof HttpBackend);
  assert.equal(http.url, "http://127.0.0.1:18001");
});

test("invalid backend config throws SolverBackendError", () => {
  assert.throws(() => createBackend({ type: "nope" }), SolverBackendError);
  assert.throws(() => new CliBackend({}), SolverBackendError);
});
