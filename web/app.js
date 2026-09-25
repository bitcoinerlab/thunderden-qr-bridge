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
  get("camera").textContent = "Start response camera";
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
  } catch { get("status").textContent = "Could not display the QR. Cancel and try again."; }
}
async function poll() {
  try {
    const response = await api("/job");
    if (response.status === 412) throw new Error("Signer changed. Restart the bridge to start a new session.");
    if (!response.ok) throw new Error("Could not reach the bridge. Reopen its local page.");
    let next = await response.json();
    if (next?.id === finishedId) next = null;
    if (next?.id !== job?.id) {
      if (!next && job) get("status").textContent = "Waiting for a wallet request.";
      clear();
      if (next) {
        job = next; sender = encoder(Buffer.from(next.payload, "base64")); decoder = new Decoder(); paused = false;
        get("pause").textContent = "Pause QR";
        get("pause").hidden = sender.fragmentsLength === 1;
        get("frames").textContent = sender.fragmentsLength === 1 ? "One QR code." : `${sender.fragmentsLength} source frames. Scanning collects them automatically.`;
        get("status").textContent = "Request ready. Scan it with Thunder Den.";
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
        get("progress").textContent = `Collecting response: ${decoder.progress()}%`;
        if (payload) {
          const response = await api(`/reply/${id}`, "POST", payload);
          if (job?.id !== id || stream !== camera) return;
          if (response.ok) {
            finishedId = id;
            clear(); get("status").textContent = "Response delivered. The wallet will check it."; return;
          }
          if (response.status === 412) {
            clear(); get("status").textContent = "Signer changed. Restart the bridge to start a new session."; return;
          }
          decoder = new Decoder();
          get("progress").textContent = "That response is for a different request. Scan the current response.";
        }
      }
    }
  } catch {
    decoder = new Decoder();
    get("progress").textContent = "Could not read that response. Keep the current QR in view.";
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
    get("video").hidden = false; get("camera").textContent = "Stop response camera";
    scan(id, camera);
  } catch { get("progress").textContent = "Could not open the camera. Check browser permission and try again."; }
  finally { get("camera").disabled = false; }
};
get("pause").onclick = () => { paused = !paused; get("pause").textContent = paused ? "Resume QR" : "Pause QR"; };
get("cancel").onclick = async () => {
  if (!job) return;
  const id = job.id;
  try {
    const response = await api(`/cancel/${id}`, "POST", new Uint8Array());
    if (response.ok && job?.id === id) {
      finishedId = id; clear();
      get("status").textContent = "Request cancelled here. Press Esc on the offline device too.";
    }
  } catch { get("status").textContent = "Could not reach the bridge. Press Esc on the offline device and try cancelling again."; }
};
window.addEventListener("pagehide", stopCamera);
poll();
