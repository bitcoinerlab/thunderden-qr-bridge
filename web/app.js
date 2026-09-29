import { Buffer } from "buffer";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { encoder, Decoder } from "./qr.js";

const get = (id) => document.getElementById(id);
const requestNames = ["Connect Thunder Den", "Share a public key", "Register a wallet", "Verify an address", "Review and sign a transaction"];
let job = null, sender = null, decoder = null, stream = null, paused = false, timer = null;
let finishedId = null, requestNumber = 0;
const capture = document.createElement("canvas");
const context = capture.getContext("2d", { willReadFrequently: true });

async function api(path, method = "GET", body) {
  return fetch(path, { method, body, cache: "no-store", credentials: "omit",
    headers: { "Content-Type": "application/cbor" } });
}
function stopCamera() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null; get("video").srcObject = null; get("video").hidden = true;
  capture.width = capture.height = 0;
  get("camera").textContent = "Scan QR code";
  get("request-view").hidden = false; get("reply-view").hidden = true;
  get("display-controls").hidden = false;
  get("progress").textContent = "";
}
function exitQrFullscreen() {
  if (document.fullscreenElement === get("qr-view")) document.exitFullscreen().catch(() => {});
}
function clear() {
  exitQrFullscreen();
  stopCamera(); clearTimeout(timer); job = null; sender = null; decoder = null;
  get("job").hidden = true;
  document.title = "Thunder Den QR bridge";
}
async function animate(id, version, first) {
  if (job?.id !== id) return;
  try {
    if (!paused && !get("request-view").hidden) {
      const canvas = get("qr");
      await QRCode.toCanvas(canvas, (first ?? sender.nextPart()).toUpperCase(),
        { version, errorCorrectionLevel: "L", margin: 4, width: 600 });
      canvas.style.width = canvas.style.height = ""; // Let CSS size the rendered QR.
    }
    if (job?.id === id && sender.fragmentsLength > 1) timer = setTimeout(() => animate(id, version), 250);
  } catch { get("status").textContent = "Could not show this QR code. Cancel the request and try again."; }
}
async function poll() {
  try {
    const response = await api("/job");
    if (response.status === 412) throw new Error("The device running Thunder Den is using a different signing key. Restart the QR bridge before trying again.");
    if (!response.ok) throw new Error("Cannot reach the QR bridge. Check that it is running, then reopen this page.");
    let next = await response.json();
    if (next?.id === finishedId) next = null;
    if (next?.id !== job?.id) {
      if (!next && job) get("status").textContent = "To begin, start an action in your wallet app on this computer. This page will show a QR code when the request is ready.";
      clear();
      if (next) {
        job = { ...next, number: ++requestNumber, name: requestNames[next.operation] ?? "Wallet request" };
        sender = encoder(Buffer.from(next.payload, "base64")); decoder = new Decoder(); paused = false;
        get("request-title").textContent = next.operation === 0
          ? "1. Scan this QR code with Thunder Den to connect it to your wallet app"
          : `1. Scan this ${job.number > 1 ? "new " : ""}QR code with Thunder Den`;
        get("pause").textContent = "Pause QR codes";
        get("pause").hidden = sender.fragmentsLength === 1;
        get("status").textContent = `New request ${job.number}: ${job.name}`;
        document.title = `Request ${job.number}: ${job.name} — Thunder Den QR bridge`;
        get("progress").textContent = ""; get("job").hidden = false;
        get("status").scrollIntoView();
        const first = sender.nextPart();
        const probe = "A".repeat(first.length + 64);
        const version = QRCode.create(probe, { errorCorrectionLevel: "L" }).version;
        await animate(job.id, version, first);
      }
    }
  } catch (error) { clear(); get("status").textContent = error.message; }
  setTimeout(poll, 500);
}
async function scan(id, camera) {
  if (stream !== camera || job?.id !== id) return;
  const video = get("video");
  try {
    if (video.readyState >= 2 && video.videoWidth) {
      capture.width = Math.min(960, video.videoWidth);
      capture.height = Math.round(video.videoHeight * capture.width / video.videoWidth);
      context.drawImage(video, 0, 0, capture.width, capture.height);
      const image = context.getImageData(0, 0, capture.width, capture.height);
      const qr = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
      if (qr) {
        const payload = decoder.receive(qr.data);
        get("progress").textContent = `Scanning the QR code: ${decoder.progress()}%`;
        if (payload) {
          const response = await api(`/reply/${id}`, "POST", payload);
          if (job?.id !== id || stream !== camera) return;
          if (response.ok) {
            finishedId = id;
            const connecting = job.operation === 0;
            get("last-reply").textContent = `Reply sent for request ${job.number}: ${job.name}.`;
            get("last-reply").hidden = false;
            clear();
            get("status").innerHTML = connecting
              ? "<strong>Keep watching this page for the next QR code.</strong>Your wallet may ask for your public key in the next few seconds. Complete any prompts in your wallet app, then return here."
              : "Check your wallet app. Keep this page open: another request may follow with a new QR code.";
            get("status").scrollIntoView();
            return;
          }
          if (response.status === 412) {
            clear(); get("status").textContent = "The device running Thunder Den is using a different signing key. Restart the QR bridge before trying again."; return;
          }
          decoder = new Decoder();
          get("progress").textContent = "We could not use that QR code for this request. Check the device running Thunder Den and try scanning its code again.";
        }
      }
    }
  } catch {
    decoder = new Decoder();
    get("progress").textContent = "Could not read that QR code. Keep the screen of the device running Thunder Den in view and try again.";
  }
  if (stream === camera && job?.id === id) setTimeout(() => scan(id, camera), 200);
}
get("camera").onclick = async () => {
  if (stream) { stopCamera(); get("status").scrollIntoView(); return; }
  const id = job?.id;
  if (!id) return;
  get("camera").disabled = true;
  get("progress").textContent = "";
  try {
    const camera = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 960 } }, audio: false });
    if (job?.id !== id) { camera.getTracks().forEach((track) => track.stop()); return; }
    exitQrFullscreen();
    stream = camera; decoder = new Decoder(); get("video").srcObject = stream;
    get("request-view").hidden = true; get("reply-view").hidden = false;
    get("display-controls").hidden = true;
    get("video").hidden = false; get("camera").textContent = "Back to request QR";
    get("qr-view").scrollIntoView();
    scan(id, camera);
  } catch { get("progress").textContent = "Could not open the camera. Allow camera access in your browser, then try again."; }
  finally { get("camera").disabled = false; }
};
get("fullscreen").hidden = !document.fullscreenEnabled;
get("fullscreen").onclick = async () => {
  const id = job?.id;
  if (!id) return;
  try {
    if (document.fullscreenElement === get("qr-view")) await document.exitFullscreen();
    else {
      await get("qr-view").requestFullscreen();
      if (job?.id !== id) exitQrFullscreen();
    }
  } catch { get("status").textContent = "Could not switch full screen. You can keep scanning in this view."; }
};
document.addEventListener("fullscreenchange", () => {
  const fullscreen = document.fullscreenElement === get("qr-view");
  get("fullscreen").textContent = fullscreen ? "Exit full screen" : "Full screen";
  get("fullscreen").setAttribute("aria-pressed", String(fullscreen));
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.fullscreenElement === get("qr-view")) {
    event.preventDefault(); exitQrFullscreen();
  }
});
get("pause").onclick = () => { paused = !paused; get("pause").textContent = paused ? "Resume QR codes" : "Pause QR codes"; };
get("cancel").onclick = async () => {
  if (!job) return;
  const id = job.id;
  try {
    const response = await api(`/cancel/${id}`, "POST", new Uint8Array());
    if (response.ok && job?.id === id) {
      finishedId = id; clear();
      get("status").textContent = "Request cancelled on this page. Press Esc on the device running Thunder Den too.";
    }
  } catch { get("status").textContent = "Cannot reach the QR bridge. Press Esc on the device running Thunder Den and check that the bridge is running."; }
};
window.addEventListener("pagehide", stopCamera);
poll();
