import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
export function command(file, args, { input, ...options } = {}) {
  const result = exec(file, args, { encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024, ...options });
  result.child.stdin.end(input);
  return result;
}

// Drive a real CLI through HTTP, using only the C++ runner's public test keys.
export async function runClient({ origin, binary, args, signer, runner, env }) {
  const client = command(binary, args, { env });
  let finished = false;
  client.then(() => { finished = true; }, () => { finished = true; });
  const handled = new Set(), exchanges = [];
  try {
    while (!finished) {
      const response = await fetch(origin + "/job", { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      const job = await response.json();
      if (job && !handled.has(job.id)) {
        handled.add(job.id);
        const request = Buffer.from(job.payload, "base64");
        const { stdout } = await command(runner, ["--" + signer], { input: request.toString("hex") + "\n" });
        const reply = Buffer.from(stdout.trim(), "hex");
        const sent = await fetch(origin + "/reply/" + job.id, { method: "POST", body: reply,
          headers: { "Content-Type": "application/cbor" }, signal: AbortSignal.timeout(5000) });
        assert.equal(sent.status, 204);
        exchanges.push({ request, reply });
      }
      await delay(10);
    }
    return { ...await client, exchanges };
  } finally {
    client.child.kill();
    await client.catch(() => {});
  }
}
