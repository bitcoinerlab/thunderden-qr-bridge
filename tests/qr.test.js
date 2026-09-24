import assert from "node:assert/strict";
import test from "node:test";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { encoder, Decoder } from "../web/qr.js";
import { cborEncode, cborDecode } from "@ngraveio/bc-ur/dist/cbor.js";

function pixels(frame) {
  const { modules } = QRCode.create(frame.toUpperCase(), { errorCorrectionLevel: "L" });
  const scale = 5, width = (modules.size + 8) * scale;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    const row = Math.floor(y / scale) - 4, col = Math.floor(x / scale) - 4;
    if (row >= 0 && col >= 0 && row < modules.size && col < modules.size && modules.get(row, col)) {
      const index = (y * width + x) * 4; data[index] = data[index + 1] = data[index + 2] = 0;
    }
  }
  const result = jsQR(data, width, width);
  assert.ok(result, "QR image was not decoded");
  return result.data;
}

test("QR pixels, out-of-order fragments, duplicates and fountain recovery", () => {
  const payload = Buffer.alloc(1700, 42), send = encoder(payload), receive = new Decoder();
  const first = Array.from({ length: send.fragmentsLength }, () => send.nextPart());
  assert.equal(receive.receive(pixels(first[2])), null);
  assert.equal(receive.receive(first[2]), null);
  // Omit a source fragment and recover it from the later fountain stream.
  for (const frame of first.slice(3).reverse()) receive.receive(pixels(frame));
  let result;
  for (let i = 0; i < 100 && !result; i++) result = receive.receive(pixels(send.nextPart()));
  assert.deepEqual(Buffer.from(result), payload);
});

test("reject unsupported types, excessive counts and mixed streams", () => {
  assert.throws(() => new Decoder().receive("ur:hdkey/abcd"));
  assert.throws(() => new Decoder().receive("ur:bytes/1-999999999/abcd"));
  assert.throws(() => new Decoder().receive("A".repeat(4297)));
  const a = encoder(Buffer.alloc(600, 1)), b = encoder(Buffer.alloc(600, 2)), receive = new Decoder();
  receive.receive(a.nextPart());
  assert.throws(() => receive.receive(b.nextPart()));
});

async function optical(mode, request) {
  const child = spawn(process.env.TD_RUNNER, [mode], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout });
  const receive = new Decoder();
  try {
    const send = encoder(request);
    for (let i = 0; i < send.fragmentsLength; i++) child.stdin.write(pixels(send.nextPart()) + "\n");
    for await (const frame of lines) {
      if (!frame) break;
      const reply = receive.receive(pixels(frame));
      if (reply) return Buffer.from(reply);
    }
    throw new Error("Native QR runner did not finish");
  } finally { lines.close(); child.kill(); }
}

test("actual C++ QR commands -> QR pixels -> JS decoder -> two-signer Core verification", { skip: !process.env.TD_RUNNER, timeout: 120000 }, async () => {
  const fixture = JSON.parse(execFileSync(process.env.TD_RUNNER, ["--fixtures"], { encoding: "utf8" }));
  const wallet = [fixture.name, fixture.template, fixture.keys];
  let psbt = Buffer.from(fixture.transactions[0].psbt_hex, "hex");
  for (const [index, name] of ["alice", "bob"].entries()) {
    const id = Buffer.alloc(16, index + 1);
    const request = cborEncode([3, id, "regtest", 4,
      [wallet, Buffer.from(fixture[`${name}_proof`], "hex"), psbt]]);
    const reply = cborDecode(await optical(`--qr-${name}`, request));
    assert.equal(reply[0], 3);
    assert.equal(reply[6], 0);
    assert.deepEqual(reply[1], id);
    assert.equal(reply[3].toString("hex"), fixture[`${name}_fingerprint`]);
    psbt = reply[7][0];
  }
  const verified = execFileSync(process.env.TD_RUNNER, ["--verify"], { input: psbt.toString("hex") + "\n", encoding: "utf8" });
  assert.match(verified, /Core verified every input/);
});
