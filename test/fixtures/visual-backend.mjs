import { writeFileSync } from "node:fs";

const mode = process.argv[2] || "ok";

if (mode === "hang") {
  setInterval(() => {}, 1_000);
} else if (mode === "ignore-term") {
  writeFileSync(process.argv[3], String(process.pid));
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
} else if (mode === "stderr-fail") {
  process.stderr.write("super-secret-backend-diagnostic");
  process.exit(3);
} else if (mode === "oversize") {
  process.stdout.write("x".repeat(8_192));
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const request = JSON.parse(input);
    process.stdout.write(JSON.stringify({
      blocks: [],
      receivedAction: request.action,
      receivedImage: request.imageBase64
    }));
  });
}
