import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { encoder } from "../web/qr.js";
import { cborEncode, cborDecode } from "@ngraveio/bc-ur/dist/cbor.js";

test("browser renders requests, scans a simulated camera, rejects stale replies and clears abandoned jobs", { timeout: 60000 }, async () => {
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
        if (window.denyCamera) throw new DOMException("Camera denied", "NotAllowedError");
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
    assert.match(await page.locator("#status").textContent(), /start an action in your wallet app on this computer/);
    assert.equal(await page.locator("#job").isHidden(), true);
    assert.equal(await page.locator("h1 img").evaluate((img) => img.complete && img.naturalWidth > 0), true);
    assert.equal(await page.locator("body").evaluate((body) => getComputedStyle(body).backgroundColor), "rgb(250, 249, 246)");
    const request = (id, operation) => cborEncode([3, Buffer.alloc(16, id), "regtest", operation,
      operation === 0 ? [] : [[0x80000030, 0x80000001, 0x80000000, 0x80000002], 1]]);
    const session = (await fetch(url.origin + "/info")).headers.get("x-thunderden-session");
    const post = (id, signal = abort.signal, operation = 1) => fetch(url.origin + "/exchange", { method: "POST", body: request(id, operation),
      headers: { "Content-Type": "application/cbor", "X-Thunderden-Session": session }, signal });
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
    assert.equal(await page.locator("#status").textContent(), "New request 1: Share a public key");
    assert.equal(await page.locator("#request-title").textContent(), "1. Scan this QR code with Thunder Den");
    assert.equal(await page.locator("#camera").textContent(), "Scan QR code");
    await page.waitForFunction(() => {
      const canvas = document.getElementById("qr");
      return canvas.width > 300 && canvas.width === canvas.height;
    });
    async function enterFullscreen() {
      await page.locator("#fullscreen").click();
      await page.waitForFunction(() => document.fullscreenElement?.id === "qr-view");
      await page.locator("#fullscreen").filter({ hasText: "Exit full screen" }).waitFor();
      assert.equal(await page.locator("#fullscreen").getAttribute("aria-pressed"), "true");
      const button = await page.locator("#fullscreen").boundingBox();
      const viewport = page.viewportSize();
      assert.ok(button.y >= 0 && button.y + button.height <= viewport.height, "Full-screen exit must stay in view");
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    const normalQr = await page.locator("#qr").boundingBox();
    await enterFullscreen();
    const largeQr = await page.locator("#qr").boundingBox();
    assert.ok(Math.min(largeQr.width, largeQr.height) > Math.min(normalQr.width, normalQr.height), `Full screen must enlarge the QR: ${JSON.stringify({ normalQr, largeQr })}`);
    await page.locator("#fullscreen").click();
    await page.waitForFunction(() => document.fullscreenElement === null);
    await enterFullscreen();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.fullscreenElement === null && document.getElementById("fullscreen").textContent === "Full screen");
    assert.equal(await page.locator("#fullscreen").textContent(), "Full screen");
    await page.setViewportSize({ width: 375, height: 720 });
    await enterFullscreen();
    await page.locator("#fullscreen").click();
    await page.waitForFunction(() => document.fullscreenElement === null);
    const narrowQr = await page.locator("#qr").boundingBox();
    assert.ok(Math.abs(narrowQr.width - narrowQr.height) < 1, "The normal QR must stay square on a narrow screen");
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.evaluate(() => { window.denyCamera = true; });
    await page.locator("#camera").click();
    await page.locator("#progress").filter({ hasText: "Could not open the camera" }).waitFor();
    assert.equal(await page.locator("#qr").isVisible(), true);
    assert.equal(await page.locator("#reply-view").isHidden(), true);
    await page.evaluate(() => { window.denyCamera = false; });
    const image = await page.locator("#qr").evaluate((canvas) => {
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
      return { data: Array.from(pixels.data), width: pixels.width, height: pixels.height };
    });
    const scanned = jsQR(new Uint8ClampedArray(image.data), image.width, image.height);
    assert.ok(scanned, "Browser request canvas was unreadable");
    native = spawn(process.env.TD_RUNNER || fileURLToPath(new URL("./signer-runner", import.meta.url)), ["--qr-alice"], { stdio: ["pipe", "pipe", "inherit"] });
    native.stdin.end(scanned.data + "\n");
    const lines = createInterface({ input: native.stdout });
    const frames = [];
    for await (const frame of lines) { if (frame) frames.push(frame); }
    assert.ok(frames.length);
    await page.locator("#camera").click();
    await page.waitForFunction(() => !!window.paintQR);
    await page.locator("#video").waitFor({ state: "visible" });
    assert.equal(await page.locator("#qr").isHidden(), true);
    assert.equal(await page.locator("#request-view").isHidden(), true);
    assert.equal(await page.locator("#camera").textContent(), "Back to request QR");
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 720 });
      const button = await page.locator("#camera").boundingBox();
      const preview = await page.locator("#video").boundingBox();
      assert.ok(preview.y + preview.height <= button.y, "Camera button must be below the preview");
      assert.ok(Math.abs(button.x - preview.x) < 1, "Camera button and preview must share the same left edge");
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.locator("#camera").click();
    await page.waitForFunction(() => window.testCamera.getTracks().every((track) => track.readyState === "ended"));
    assert.equal(await page.locator("#qr").isVisible(), true);
    assert.equal(await page.locator("#reply-view").isHidden(), true);
    assert.equal((await fetch(url.origin + "/job").then((response) => response.json())).id, Buffer.alloc(16, 1).toString("hex"));
    await page.locator("#camera").click();
    await page.waitForFunction(() => window.testCamera.getTracks().some((track) => track.readyState === "live"));
    async function paint(frame) {
      const { modules } = QRCode.create(frame.toUpperCase(), { errorCorrectionLevel: "L" });
      await page.evaluate((data) => window.paintQR(data), { size: modules.size, data: Array.from(modules.data) });
      await page.waitForTimeout(350);
    }
    const stale = encoder(cborEncode([3, Buffer.alloc(16, 9), "regtest", Buffer.alloc(4), "0.0.1", 1, 1, []]));
    for (let i = 0; i < stale.fragmentsLength; i++) await paint(stale.nextPart());
    await page.locator("#progress").filter({ hasText: "could not use that QR code for this request" }).waitFor();
    let delivered = false;
    const result = pending.then(async (response) => { delivered = true; assert.equal(response.status, 200); return Buffer.from(await response.arrayBuffer()); });
    for (let i = 0; i < 10 && !delivered; i++) for (const frame of frames) {
      if (!delivered) await paint(frame);
    }
    assert.ok(delivered, "Browser camera did not finish the response");
    const reply = cborDecode(await result);
    assert.equal(reply[0], 3);
    assert.equal(reply[4], "0.0.1");
    assert.equal(reply[6], 0);
    assert.deepEqual(reply[1], Buffer.alloc(16, 1));
    await page.waitForFunction(() => window.testCamera.getTracks().every((track) => track.readyState === "ended"));
    await page.locator("#last-reply").filter({ hasText: "Reply sent for request 1: Share a public key." }).waitFor();
    assert.match(await page.locator("#status").textContent(), /another request may follow with a new QR code/);

    // A connection reply can be followed by a separate request for the wallet key.
    const connecting = post(2, abort.signal, 0);
    await page.locator("#cancel").waitFor({ state: "visible" });
    await page.locator("#request-title").filter({ hasText: "Scan this QR code with Thunder Den to connect it to your wallet app" }).waitFor();
    assert.equal(await page.locator("#status").textContent(), "New request 2: Connect Thunder Den");
    assert.equal(await page.locator("#camera").textContent(), "Scan QR code");
    await page.locator("#camera").click();
    await page.waitForFunction(() => window.testCamera.getTracks().some((track) => track.readyState === "live"));
    const info = encoder(cborEncode([3, Buffer.alloc(16, 2), "regtest", reply[3], "0.0.1", 0, 0, []]));
    for (let i = 0; i < info.fragmentsLength; i++) await paint(info.nextPart());
    assert.equal((await connecting).status, 200);
    await page.locator("#last-reply").filter({ hasText: "Reply sent for request 2: Connect Thunder Den." }).waitFor();

    const cancelled = post(3);
    await page.locator("#status").filter({ hasText: "New request 3: Share a public key" }).waitFor();
    assert.match(await page.title(), /Request 3: Share a public key/);
    assert.equal(await page.locator("#request-title").textContent(), "1. Scan this new QR code with Thunder Den");
    assert.equal(await page.locator("#last-reply").textContent(), "Reply sent for request 2: Connect Thunder Den.");
    assert.equal(await page.locator("#video").isHidden(), true);
    const status = await page.locator("#status").boundingBox();
    assert.ok(status.y >= 0 && status.y + status.height <= 720, "New request must be scrolled into view");
    await enterFullscreen();
    // A cancelled/replaced request must leave full screen to show the next action.
    assert.equal((await fetch(url.origin + `/cancel/${Buffer.alloc(16, 3).toString("hex")}`, {
      method: "POST", headers: { "Content-Type": "application/cbor" }, body: Buffer.alloc(0),
    })).status, 204);
    assert.equal((await cancelled).status, 410);
    await page.locator("#job").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.fullscreenElement === null);
    const disconnected = new AbortController();
    const abandoned = post(4, disconnected.signal);
    abandoned.catch(() => {});
    await page.locator("#status").filter({ hasText: "New request 4: Share a public key" }).waitFor();
    assert.equal(await page.locator("#request-title").textContent(), "1. Scan this new QR code with Thunder Den");
    assert.equal(await page.locator("#request-view").isVisible(), true);
    assert.equal(await page.locator("#reply-view").isHidden(), true);
    await page.locator("#camera").click();
    await page.waitForFunction(() => window.testCamera.getTracks().some((track) => track.readyState === "live"));
    disconnected.abort();
    await assert.rejects(abandoned);
    await page.locator("#status").filter({ hasText: "start an action in your wallet app on this computer" }).waitFor();
    assert.equal(await page.locator("#job").isHidden(), true);
    await page.waitForFunction(() => window.testCamera.getTracks().every((track) => track.readyState === "ended"));

    // Exercise an animated request without submitting it to the signer.
    const animated = fetch(url.origin + "/exchange", { method: "POST",
      headers: { "Content-Type": "application/cbor", "X-Thunderden-Session": session }, signal: abort.signal,
      body: cborEncode([3, Buffer.alloc(16, 5), "regtest", 4, [Buffer.alloc(1700, 42)]]),
    });
    animated.catch(() => {});
    await page.locator("#pause").waitFor({ state: "visible" });
    await page.locator("#pause").click();
    const pausedFrame = await page.locator("#qr").evaluate((canvas) => canvas.toDataURL());
    await page.waitForTimeout(350);
    assert.equal(await page.locator("#qr").evaluate((canvas) => canvas.toDataURL()), pausedFrame);
    await page.locator("#pause").click();
    await page.waitForFunction((previous) => document.getElementById("qr").toDataURL() !== previous, pausedFrame);
    await page.setViewportSize({ width: 375, height: 720 });
    await enterFullscreen();
    await page.locator("#fullscreen").click();
    await page.waitForFunction(() => document.fullscreenElement === null);
    await page.locator("#camera").click();
    await page.locator("#video").waitFor({ state: "visible" });
    assert.equal(await page.locator("#qr").isHidden(), true);
    const hiddenFrame = await page.locator("#qr").evaluate((canvas) => canvas.toDataURL());
    await page.waitForTimeout(350);
    assert.equal(await page.locator("#qr").evaluate((canvas) => canvas.toDataURL()), hiddenFrame);
    await page.locator("#camera").click();
    await page.waitForFunction(() => window.testCamera.getTracks().every((track) => track.readyState === "ended"));
    await page.waitForFunction((previous) => document.getElementById("qr").toDataURL() !== previous, hiddenFrame);
    await page.locator("#cancel").click();
    assert.equal((await animated).status, 410);
    await page.locator("#job").waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
    console.log(`Browser: ${await browser.version()}; public xpub response, cancellation and client disconnect passed`);
  } finally {
    abort.abort(); native?.kill(); await browser?.close(); startup.close(); server.kill();
  }
});
