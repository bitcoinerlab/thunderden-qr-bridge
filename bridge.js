#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MAX_REQUEST = 1024 * 1024 + 65536;
export const MAX_REPLY = 2 * 1024 * 1024 + 65536;

function requestId(data, prefix) {
  return data.length >= 19 && data[0] === prefix && data[1] === 3 && data[2] === 0x50
    ? data.subarray(3, 19).toString("hex") : null;
}

export async function startBridge(port = 32123) {
  const assets = new Map(await Promise.all([
    ["/", "web/index.html", "text/html; charset=utf-8"],
    ["/app.js", "dist/app.js", "text/javascript"],
    ["/style.css", "web/style.css", "text/css"],
  ].map(async ([path, file, type]) => [path, { body: await readFile(new URL(file, import.meta.url)), type }])));
  let job = null, origin;
  const server = createServer(async (req, res) => {
    const send = (status, body = "", type = "text/plain") => {
      res.writeHead(status, {
        "Content-Type": type, "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      });
      res.end(body);
    };
    try {
      if (req.headersDistinct.host?.length !== 1 || req.headers.host !== new URL(origin).host
          || (req.headers.origin !== undefined && (req.headersDistinct.origin.length !== 1 || req.headers.origin !== origin))
          || ["cross-site", "same-site"].includes(req.headers["sec-fetch-site"])) {
        send(403); return;
      }
      if (req.method === "GET") {
        if (assets.has(req.url)) {
          const { body, type } = assets.get(req.url);
          send(200, body, type);
        } else if (req.url === "/info") {
          send(200, "thunderden-qr-bridge");
        } else if (req.url === "/job") {
          send(200, JSON.stringify(job ? { id: job.id, payload: job.payload } : null), "application/json");
        } else send(404);
        return;
      }
      if (req.method !== "POST") { send(405); return; }
      // A non-simple content type prevents HTML forms from submitting commands.
      if (req.headers["content-type"] !== "application/cbor") { send(415); return; }
      const action = /^\/(reply|cancel)\/([0-9a-f]{32})$/.exec(req.url);
      if (req.url !== "/exchange" && !action) { send(404); return; }
      const maximum = req.url === "/exchange" ? MAX_REQUEST : action[1] === "reply" ? MAX_REPLY : 0;
      const tooLarge = () => { res.setHeader("Connection", "close"); send(413); };
      if (Number(req.headers["content-length"]) > maximum) { tooLarge(); return; }
      const chunks = [];
      let length = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        length += chunk.length;
        if (length > maximum) { tooLarge(); return; }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks, length);
      if (res.destroyed) return;
      if (req.url === "/exchange") {
        const id = requestId(body, 0x85);
        if (!id) { send(400); return; }
        if (job) { send(409); return; }
        job = { id, payload: body.toString("base64"), send, res };
        // Dropping the CLI connection discards this exchange, never retries it.
        res.on("close", () => { if (job?.res === res) job = null; });
      } else {
        if (!job || action[2] !== job.id
            || (action[1] === "reply" && requestId(body, 0x88) !== job.id)) {
          send(409); return;
        }
        job.send(action[1] === "reply" ? 200 : 410, body, "application/cbor");
        job = null;
        send(204);
      }
    } catch {
      if (!res.destroyed && !res.headersSent) send(400);
      else res.destroy();
    }
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));
  origin = new URL(`http://127.0.0.1:${server.address().port}`).origin;
  return server;
}

async function main() {
  const { values } = parseArgs({ options: {
    port: { type: "string", default: "32123" }, "no-open": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help) {
    console.log("Usage: thunderden-qr-bridge [--port PORT] [--no-open]"); return;
  }
  const port = Number(values.port);
  if (!/^\d+$/.test(values.port) || !Number.isInteger(port) || port > 65535) throw new Error("Invalid port");
  const server = await startBridge(port);
  const url = `http://127.0.0.1:${server.address().port}`;
  console.log(`Open ${url}`);
  if (!values["no-open"]) {
    const command = process.platform === "win32" ? ["cmd.exe", "/c", "start", "", url]
      : process.platform === "darwin" ? ["open", url] : ["xdg-open", url];
    const child = spawn(command[0], command.slice(1), { stdio: "ignore" });
    child.on("error", () => console.error(`Open ${url} in your browser.`));
    child.unref();
  }
  const stop = () => { server.close(); server.closeAllConnections(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
