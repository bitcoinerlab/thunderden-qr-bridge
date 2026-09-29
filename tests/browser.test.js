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
    assert.equal(await page.locator("#request-title").textContent(), "1. Scan this QR with Thunder Den");
    assert.equal(await page.locator("#camera").textContent(), "Open camera →");
    assert.equal(await page.locator("#reply-prompt").textContent(), "When Thunder Den shows its reply QR:");
    assert.equal(await page.locator("#camera").getAttribute("aria-describedby"), "reply-prompt progress");
    assert.equal(await page.locator("#pause").count(), 0);
    await page.waitForFunction(() => {
      const canvas = document.getElementById("qr");
      return canvas.width > 300 && canvas.width === canvas.height;
    });
    async function readRequestQR() {
      // Decode browser-rendered pixels, including the viewport-dependent sizing.
      const png = await page.locator("#qr").screenshot();
      const image = await page.evaluate(async (data) => {
        const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext("2d"); context.drawImage(bitmap, 0, 0);
        return { data: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data), width: canvas.width, height: canvas.height };
      }, png.toString("base64"));
      return jsQR(new Uint8ClampedArray(image.data), image.width, image.height);
    }
    async function checkPreviewLayout(selector) {
      const preview = await page.locator(selector).boundingBox();
      const view = await page.locator("#qr-view").boundingBox();
      const viewport = page.viewportSize();
      assert.ok(Math.abs(preview.x + preview.width / 2 - view.x - view.width / 2) < 1, "Preview must be centered");
      assert.ok(preview.y >= 0 && preview.y + preview.height <= viewport.height, "The entire preview must be on screen");
      assert.ok(preview.x >= 0 && preview.x + preview.width <= viewport.width, "Preview must fit the viewport width");
      assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1), true, "No scrolling should be needed");
      for (const control of await page.locator("#job button:visible").all()) {
        const button = await control.boundingBox();
        if (await control.getAttribute("id") !== "camera")
          assert.ok(button.y + button.height <= preview.y, "Display/navigation controls must be above the preview");
        assert.ok(button.y >= 0 && button.y + button.height <= viewport.height, "Controls must stay in view");
        assert.ok(button.x >= 0 && button.x + button.width <= viewport.width, "Controls must fit the viewport");
      }
      if (selector === "#qr") {
        const next = await page.locator("#next-step").boundingBox();
        assert.ok(preview.y + preview.height <= next.y, "The next step must be below the QR without covering it");
        assert.ok(next.y + next.height <= viewport.height, "The complete next step must stay on screen");
        assert.ok(Math.abs(preview.width - preview.height) < 1, "QR must stay square");
        assert.ok(await readRequestQR(), `Rendered QR must remain readable at ${viewport.width}×${viewport.height}`);
      }
    }
    async function enterFullscreen() {
      await page.locator("#fullscreen").click();
      await page.waitForFunction(() => document.fullscreenElement?.id === "qr-view");
      await page.locator("#fullscreen").filter({ hasText: "Exit full screen" }).waitFor();
      assert.equal(await page.locator("#fullscreen").getAttribute("aria-pressed"), "true");
      const button = await page.locator("#fullscreen").boundingBox();
      const viewport = page.viewportSize();
      assert.ok(button.y >= 0 && button.y + button.height <= viewport.height, "Full-screen exit must stay in view");
      assert.equal(await page.locator("#camera").isVisible(), true);
      assert.equal(await page.locator("#cancel").isVisible(), true);
      await checkPreviewLayout("#qr");
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    const normalQr = await page.locator("#qr").boundingBox();
    await checkPreviewLayout("#qr");
    await enterFullscreen();
    const largeQr = await page.locator("#qr").boundingBox();
    assert.ok(Math.min(largeQr.width, largeQr.height) > Math.min(normalQr.width, normalQr.height), `Full screen must enlarge the QR: ${JSON.stringify({ normalQr, largeQr })}`);
    await page.locator("#fullscreen").click();
    await page.waitForFunction(() => document.fullscreenElement === null);
    await enterFullscreen();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.fullscreenElement === null && document.getElementById("fullscreen").textContent === "Full screen");
    assert.equal(await page.locator("#fullscreen").textContent(), "Full screen");
    for (const viewport of [{ width: 1280, height: 600 }, { width: 375, height: 720 }, { width: 320, height: 568 }]) {
      await page.setViewportSize(viewport);
      await checkPreviewLayout("#qr");
    }
    await page.setViewportSize({ width: 375, height: 720 });
    await enterFullscreen();
    await page.locator("#fullscreen").click();
    await page.waitForFunction(() => document.fullscreenElement === null);
    const narrowQr = await page.locator("#qr").boundingBox();
    assert.ok(Math.abs(narrowQr.width - narrowQr.height) < 1, "The normal QR must stay square on a narrow screen");
    await checkPreviewLayout("#qr");
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.evaluate(() => { window.denyCamera = true; });
    await page.locator("#camera").click();
    await page.locator("#progress").filter({ hasText: "Could not open the camera" }).waitFor();
    assert.equal(await page.locator("#qr").isVisible(), true);
    assert.equal(await page.locator("#reply-view").isHidden(), true);
    await checkPreviewLayout("#qr");
    const error = await page.locator("#progress").boundingBox();
    const next = await page.locator("#next-step").boundingBox();
    assert.ok(error.y >= next.y + next.height && error.y + error.height <= 720, "Camera error must be visible beside the next step");
    await page.evaluate(() => { window.denyCamera = false; });
    const scanned = await readRequestQR();
    assert.ok(scanned, "Browser request canvas was unreadable");
    native = spawn(process.env.TD_RUNNER || fileURLToPath(new URL("./signer-runner", import.meta.url)), ["--qr-alice"], { stdio: ["pipe", "pipe", "inherit"] });
    native.stdin.end(scanned.data + "\n");
    const lines = createInterface({ input: native.stdout });
    const frames = [];
    for await (const frame of lines) { if (frame) frames.push(frame); }
    assert.ok(frames.length);
    await enterFullscreen();
    await page.locator("#camera").click();
    await page.waitForFunction(() => document.fullscreenElement === null);
    await page.waitForFunction(() => !!window.paintQR);
    await page.locator("#video").waitFor({ state: "visible" });
    assert.equal(await page.locator("#qr").isHidden(), true);
    assert.equal(await page.locator("#request-view").isHidden(), true);
    assert.equal(await page.locator("#back").textContent(), "← Back to request QR");
    assert.equal(await page.locator("#next-step").isHidden(), true);
    assert.equal(await page.locator("#fullscreen").isHidden(), true);
    assert.equal(await page.locator("#reply-title").isVisible(), true);
    for (const viewport of [{ width: 1280, height: 720 }, { width: 375, height: 720 }, { width: 320, height: 568 }]) {
      await page.setViewportSize(viewport);
      await checkPreviewLayout("#video");
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.locator("#back").click();
    await page.waitForFunction(() => window.testCamera.getTracks().every((track) => track.readyState === "ended"));
    assert.equal(await page.locator("#qr").isVisible(), true);
    assert.equal(await page.locator("#reply-view").isHidden(), true);
    assert.equal(await page.locator("#fullscreen").isVisible(), true);
    assert.equal(await page.locator("#next-step").isVisible(), true);
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
    await page.locator("#request-title").filter({ hasText: "Scan this new QR with Thunder Den" }).waitFor();
    assert.equal(await page.locator("#status").textContent(), "New request 2: Connect Thunder Den");
    assert.equal(await page.locator("#camera").textContent(), "Open camera →");
    await page.setViewportSize({ width: 320, height: 568 });
    await checkPreviewLayout("#qr");
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.locator("#camera").click();
    await page.waitForFunction(() => window.testCamera.getTracks().some((track) => track.readyState === "live"));
    const info = encoder(cborEncode([3, Buffer.alloc(16, 2), "regtest", reply[3], "0.0.1", 0, 0, []]));
    for (let i = 0; i < info.fragmentsLength; i++) await paint(info.nextPart());
    assert.equal((await connecting).status, 200);
    await page.locator("#last-reply").filter({ hasText: "Reply sent for request 2: Connect Thunder Den." }).waitFor();
    await page.locator("#status strong").filter({ hasText: "Keep watching this page for the next QR code." }).waitFor();
    assert.match(await page.locator("#status").textContent(), /wallet may ask for your public key/);
    const notice = await page.locator("#status").boundingBox();
    assert.ok(notice.y >= 0 && notice.y + notice.height <= 720, "Connection follow-up must be scrolled into view");
    assert.equal(await page.locator("#status strong").evaluate((text) => Number(getComputedStyle(text).fontWeight) >= 700), true);

    const cancelled = post(3);
    await page.locator("#status").filter({ hasText: "New request 3: Share a public key" }).waitFor();
    assert.match(await page.title(), /Request 3: Share a public key/);
    assert.equal(await page.locator("#request-title").textContent(), "1. Scan this new QR with Thunder Den");
    assert.equal(await page.locator("#last-reply").textContent(), "Reply sent for request 2: Connect Thunder Den.");
    assert.equal(await page.locator("#status strong").count(), 0);
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
    assert.equal(await page.locator("#request-title").textContent(), "1. Scan this new QR with Thunder Den");
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
    await page.locator("#status").filter({ hasText: "New request 5: Review and sign a transaction" }).waitFor();
    const firstFrame = await page.locator("#qr").evaluate((canvas) => canvas.toDataURL());
    await page.waitForFunction((previous) => document.getElementById("qr").toDataURL() !== previous, firstFrame);
    for (const viewport of [{ width: 1280, height: 600 }, { width: 375, height: 720 }, { width: 320, height: 568 }]) {
      await page.setViewportSize(viewport);
      await checkPreviewLayout("#qr");
    }
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
    await page.locator("#back").click();
    await page.waitForFunction(() => window.testCamera.getTracks().every((track) => track.readyState === "ended"));
    await page.waitForFunction((previous) => document.getElementById("qr").toDataURL() !== previous, hiddenFrame);
    await page.locator("#cancel").click();
    assert.equal((await animated).status, 410);
    await page.locator("#job").waitFor({ state: "hidden" });

    const fullscreenCancelled = post(6);
    await page.locator("#status").filter({ hasText: "New request 6: Share a public key" }).waitFor();
    await enterFullscreen();
    await page.locator("#cancel").click();
    assert.equal((await fullscreenCancelled).status, 410);
    await page.waitForFunction(() => document.fullscreenElement === null);
    await page.locator("#job").waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
    console.log(`Browser: ${await browser.version()}; public xpub response, cancellation and client disconnect passed`);
  } finally {
    abort.abort(); native?.kill(); await browser?.close(); startup.close(); server.kill();
  }
});
