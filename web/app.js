import { Buffer } from "buffer";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { encoder, Decoder } from "./qr.js";

const get = (id) => document.getElementById(id);
let job = null, sender = null, decoder = null, stream = null, paused = false, timer = null;
let finishedId = null;
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
  get("camera").textContent = "Start camera to scan the QR code";
}
function clear() {
  stopCamera(); clearTimeout(timer); job = null; sender = null; decoder = null;
  get("job").hidden = true;
}
async function animate(id, version, first) {
  if (job?.id !== id) return;
  try {
    if (!paused) await QRCode.toCanvas(get("qr"), (first ?? sender.nextPart()).toUpperCase(),
      { version, errorCorrectionLevel: "L", margin: 4, width: 600 });
    if (job?.id === id && sender.fragmentsLength > 1) timer = setTimeout(() => animate(id, version), 250);
  } catch { get("status").textContent = "Could not show this QR code. Cancel the request and try again."; }
}
async function poll() {
  try {
    const response = await api("/job");
    if (response.status === 412) throw new Error("The offline device is using a different signing key. Restart the QR bridge before trying again.");
    if (!response.ok) throw new Error("Cannot reach the QR bridge. Check that it is running, then reopen this page.");
    let next = await response.json();
    if (next?.id === finishedId) next = null;
    if (next?.id !== job?.id) {
      if (!next && job) get("status").textContent = "To begin, start an action in your wallet app on this computer. This page will show a QR code when the request is ready.";
      clear();
      if (next) {
        job = next; sender = encoder(Buffer.from(next.payload, "base64")); decoder = new Decoder(); paused = false;
        get("pause").textContent = "Pause QR codes";
        get("pause").hidden = sender.fragmentsLength === 1;
        get("frames").textContent = sender.fragmentsLength === 1 ? "This request fits in one QR code." : "This request uses several QR codes. Keep your offline device pointed at this screen until it finishes scanning.";
        get("status").textContent = "A request from your wallet app is ready.";
        get("progress").textContent = ""; get("job").hidden = false;
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
            clear(); get("status").textContent = "Reply sent to your wallet app. Check the result there."; return;
          }
          if (response.status === 412) {
            clear(); get("status").textContent = "The offline device is using a different signing key. Restart the QR bridge before trying again."; return;
          }
          decoder = new Decoder();
          get("progress").textContent = "We could not use that QR code for this request. Check your offline device and try scanning its code again.";
        }
      }
    }
  } catch {
    decoder = new Decoder();
    get("progress").textContent = "Could not read that QR code. Keep your offline device's screen in view and try again.";
  }
  if (stream === camera && job?.id === id) setTimeout(() => scan(id, camera), 200);
}
get("camera").onclick = async () => {
  if (stream) { stopCamera(); return; }
  const id = job?.id;
  if (!id) return;
  get("camera").disabled = true;
  try {
    const camera = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 960 } }, audio: false });
    if (job?.id !== id) { camera.getTracks().forEach((track) => track.stop()); return; }
    stream = camera; decoder = new Decoder(); get("video").srcObject = stream;
    get("video").hidden = false; get("camera").textContent = "Stop camera";
    scan(id, camera);
  } catch { get("progress").textContent = "Could not open the camera. Allow camera access in your browser, then try again."; }
  finally { get("camera").disabled = false; }
};
get("pause").onclick = () => { paused = !paused; get("pause").textContent = paused ? "Resume QR codes" : "Pause QR codes"; };
get("cancel").onclick = async () => {
  if (!job) return;
  const id = job.id;
  try {
    const response = await api(`/cancel/${id}`, "POST", new Uint8Array());
    if (response.ok && job?.id === id) {
      finishedId = id; clear();
      get("status").textContent = "Request cancelled on this page. Press Esc on your offline device too.";
    }
  } catch { get("status").textContent = "Cannot reach the QR bridge. Press Esc on your offline device and check that the bridge is running."; }
};
window.addEventListener("pagehide", stopCamera);
poll();
