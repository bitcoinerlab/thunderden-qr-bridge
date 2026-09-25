import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("packed CLI runs through npx offline with bundled assets and no runtime dependencies", {
  timeout: 60000, skip: process.platform === "win32" && "process-group cleanup uses POSIX signals",
}, async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const temporary = await mkdtemp(join(tmpdir(), "thunderden-package-"));
  let child, lines, exited;
  try {
    const { stdout } = await promisify(execFile)("npm", ["pack", "--json", "--pack-destination", temporary], { cwd: root });
    const [packed] = JSON.parse(stdout);
    assert.equal(packed.entryCount, 9); // Manifest, README, server and six browser assets.
    assert.ok(packed.files.some((file) => file.path === "dist/app.js"));
    assert.ok(packed.files.every((file) => !file.path.endsWith(".py")));
    child = spawn("npx", ["--yes", "--offline", "--ignore-scripts", "--cache", join(temporary, "cache"),
      "--package", join(temporary, packed.filename), "thunderden-qr-bridge", "--port", "0", "--no-open"],
    { cwd: temporary, detached: true, stdio: ["ignore", "pipe", "inherit"] });
    exited = once(child, "exit");
    exited.catch(() => {});
    lines = createInterface({ input: child.stdout });
    const { value } = await lines[Symbol.asyncIterator]().next();
    assert.match(value, /^Open http:\/\/127\.0\.0\.1:\d+$/);
    const origin = value.slice("Open ".length);
    const info = await fetch(origin + "/info");
    assert.equal(info.status, 200);
    assert.equal(await info.text(), "thunderden-qr-bridge");
    for (const path of ["/", "/app.js", "/style.css", "/brand/thunderden.css",
      "/brand/thunderden-horizontal-graphite.svg", "/brand/favicon.svg"]) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 200);
      assert.ok((await response.arrayBuffer()).byteLength > 0);
    }
  } finally {
    lines?.close();
    if (child?.pid && child.exitCode === null) {
      process.kill(-child.pid, "SIGTERM");
      await exited;
    }
    await rm(temporary, { recursive: true, force: true });
  }
});
