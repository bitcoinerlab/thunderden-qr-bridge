import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { encoder } from "../web/qr.js";
import { cborEncode, cborDecode } from "@ngraveio/bc-ur/dist/cbor.js";

test("browser renders requests, scans a simulated camera, ignores stale replies and cancels", { timeout: 60000 }, async () => {
  const server = spawn(process.execPath, ["bridge.js", "--port", "0", "--no-open"], { stdio: ["ignore", "pipe", "inherit"] });
  const startup = createInterface({ input: server.stdout });
  let browser, native;
  const abort = new AbortController();
  try {
    const [line] = await startup[Symbol.asyncIterator]().next().then((row) => [row.value]);
    const url = new URL(line.slice("Open ".length));
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/usr/bin/chromium", headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => { errors.push(error.message); console.error(error.message); });
    // Only a generated canvas reaches getUserMedia. No real webcam is opened.
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = 600;
        const ctx = canvas.getContext("2d");
        window.paintQR = ({ size, data }) => {
          ctx.fillStyle = "white"; ctx.fillRect(0, 0, 600, 600); ctx.fillStyle = "black";
          const scale = Math.floor(600 / (size + 8)), offset = Math.floor((600 - size * scale) / 2);
          for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
            if (data[y * size + x]) ctx.fillRect(offset + x * scale, offset + y * scale, scale, scale);
        };
        window.testCamera = canvas.captureStream(10);
        return window.testCamera;
      };
    });
    await page.goto(url.toString());
    const request = (id) => cborEncode([3, Buffer.alloc(16, id), "regtest", 1,
      [[0x80000030, 0x80000001, 0x80000000, 0x80000002], 1]]);
    const post = (id) => fetch(url.origin + "/exchange", { method: "POST", body: request(id),
      headers: { "Content-Type": "application/cbor" }, signal: abort.signal });
    const foreign = await browser.newPage();
    await foreign.goto("data:text/html,foreign origin");
    assert.equal(await foreign.evaluate(async (origin) => {
      try {
        await fetch(origin + "/exchange", { method: "POST", headers: { "Content-Type": "application/cbor" }, body: "invalid" });
        return false;
      } catch { return true; }
    }, url.origin), true);
    await foreign.close();
    assert.equal(await fetch(url.origin + "/job").then((response) => response.json()), null);
    const pending = post(1);
    pending.catch(() => {}); // Teardown can abort a still-pending exchange.
    await page.locator("#qr").waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const canvas = document.getElementById("qr");
      return canvas.width > 300 && canvas.width === canvas.height;
    });
    const image = await page.locator("#qr").evaluate((canvas) => {
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
      return { data: Array.from(pixels.data), width: pixels.width, height: pixels.height };
    });
    const scanned = jsQR(new Uint8ClampedArray(image.data), image.width, image.height);
    assert.ok(scanned, "Browser request canvas was unreadable");
    native = spawn(process.env.TD_RUNNER || "./native-runner", ["--qr-alice"], { stdio: ["pipe", "pipe", "inherit"] });
    native.stdin.end(scanned.data + "\n");
    const lines = createInterface({ input: native.stdout });
    const frames = [];
    for await (const frame of lines) { if (frame) frames.push(frame); }
    assert.ok(frames.length);
    await page.locator("#camera").click();
    await page.waitForFunction(() => !!window.paintQR);
    async function paint(frame) {
      const { modules } = QRCode.create(frame.toUpperCase(), { errorCorrectionLevel: "L" });
      await page.evaluate((data) => window.paintQR(data), { size: modules.size, data: Array.from(modules.data) });
      await page.waitForTimeout(350);
    }
    const stale = encoder(cborEncode([3, Buffer.alloc(16, 9), "regtest", Buffer.alloc(4), "development", 1, 1, []]));
    for (let i = 0; i < stale.fragmentsLength; i++) await paint(stale.nextPart());
    await page.locator("#progress").filter({ hasText: "different request" }).waitFor();
    let delivered = false;
    const result = pending.then(async (response) => { delivered = true; assert.equal(response.status, 200); return Buffer.from(await response.arrayBuffer()); });
    for (let i = 0; i < 10 && !delivered; i++) for (const frame of frames) {
      if (!delivered) await paint(frame);
    }
    assert.ok(delivered, "Browser camera did not finish the response");
    const reply = cborDecode(await result);
    assert.equal(reply[0], 3);
    assert.equal(reply[6], 0);
    assert.deepEqual(reply[1], Buffer.alloc(16, 1));
    await page.waitForFunction(() => window.testCamera.getTracks().every((track) => track.readyState === "ended"));
    const cancelled = post(2);
    await page.locator("#cancel").waitFor({ state: "visible" });
    await page.locator("#cancel").click();
    assert.equal((await cancelled).status, 410);
    assert.deepEqual(errors, []);
    console.log(`Browser: ${await browser.version()}; public xpub response and cancellation passed`);
  } finally {
    abort.abort(); native?.kill(); await browser?.close(); startup.close(); server.kill();
  }
});
