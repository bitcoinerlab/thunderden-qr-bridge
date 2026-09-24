import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { startBridge, MAX_REQUEST, MAX_REPLY } from "../bridge.js";

async function setup(t) {
  const server = await startBridge(0);
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  function request(method, path, body = Buffer.alloc(0), headers = {}) {
    let req;
    const result = new Promise((resolve, reject) => {
      req = httpRequest(origin, { method, path, headers: { "Content-Type": "application/cbor", ...headers } }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.end(body);
    });
    result.abort = () => req.destroy(new Error("Client disconnected"));
    result.catch(() => {}); // A failed assertion can close a still-pending exchange.
    return result;
  }
  async function waitJob(id) {
    for (let i = 0; i < 300; i++) {
      const { status, body } = await request("GET", "/job");
      assert.equal(status, 200);
      const job = JSON.parse(body);
      if ((job?.id ?? null) === id) return job;
      await delay(10);
    }
    assert.fail("Bridge did not reach the expected job state");
  }
  return { request, waitJob, origin };
}

const id = (number) => Buffer.alloc(16, number).toString("hex");
const message = (number, prefix = 0x85) => Buffer.concat([
  Buffer.from([prefix, 3, 0x50]), Buffer.alloc(16, number), Buffer.from("opaque payload"),
]);

test("availability, static assets and browser access boundaries", async (t) => {
  const { request, origin, waitJob } = await setup(t);
  assert.equal((await request("GET", "/info")).body.toString(), "thunderden-qr-bridge");
  await waitJob(null);
  for (const path of ["/", "/app.js", "/style.css"]) assert.equal((await request("GET", path)).status, 200);
  for (const headers of [
    { Origin: "https://other.example" }, { Origin: "null" }, { Host: "other.example" },
    { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" },
  ]) assert.equal((await request("GET", "/job", undefined, headers)).status, 403);
  assert.equal((await request("GET", "/job", undefined, { Origin: origin })).status, 200);
  assert.equal((await request("GET", "/../../README.md")).status, 404);
  assert.equal((await request("OPTIONS", "/exchange")).status, 405);
  for (const type of ["text/plain", "application/x-www-form-urlencoded", "application/json"]) {
    assert.equal((await request("POST", "/exchange", message(1), { "Content-Type": type })).status, 415);
  }
  assert.equal((await request("POST", "/exchange", message(1), { Origin: "https://other.example" })).status, 403);
  await waitJob(null);
});

test("bounded bodies and fixed command headers", async (t) => {
  const { request } = await setup(t);
  assert.equal((await request("POST", "/exchange", "", { "Content-Length": MAX_REQUEST + 1 })).status, 413);
  assert.equal((await request("POST", "/exchange", Buffer.alloc(MAX_REQUEST + 1), { "Transfer-Encoding": "chunked" })).status, 413);
  assert.equal((await request("POST", `/reply/${id(1)}`, "", { "Content-Length": MAX_REPLY + 1 })).status, 413);
  assert.equal((await request("POST", `/cancel/${id(1)}`, "not empty")).status, 413);
  for (const body of [Buffer.from("invalid"), message(1, 0x86), Buffer.from([0x85, 2, 0x50])]) {
    assert.equal((await request("POST", "/exchange", body)).status, 400);
  }
});

test("one exchange, cancellation and stale reply rejection", async (t) => {
  const { request, waitJob } = await setup(t);
  const old = request("POST", "/exchange", message(1));
  const job = await waitJob(id(1));
  assert.deepEqual(Buffer.from(job.payload, "base64"), message(1));
  assert.equal((await request("POST", "/exchange", message(2))).status, 409);
  assert.equal((await request("POST", `/cancel/${id(1)}`)).status, 204);
  assert.equal((await old).status, 410);
  const current = request("POST", "/exchange", message(2));
  await waitJob(id(2));
  assert.equal((await request("POST", `/reply/${id(1)}`, message(1, 0x88))).status, 409);
  assert.equal((await request("POST", `/reply/${id(2)}`, message(1, 0x88))).status, 409);
  assert.equal((await request("POST", `/reply/${id(2)}`, message(2, 0x88))).status, 204);
  assert.deepEqual(await current, { status: 200, body: message(2, 0x88) });
  await waitJob(null);
});

test("a disconnected client releases the job and late replies cannot complete a new one", async (t) => {
  const { request, waitJob } = await setup(t);
  const abandoned = request("POST", "/exchange", message(1));
  await waitJob(id(1));
  abandoned.abort();
  await assert.rejects(abandoned, /Client disconnected/);
  await waitJob(null);
  const current = request("POST", "/exchange", message(2));
  await waitJob(id(2));
  assert.equal((await request("POST", `/reply/${id(1)}`, message(1, 0x88))).status, 409);
  assert.equal((await request("POST", `/reply/${id(2)}`, message(2, 0x88))).status, 204);
  assert.equal((await current).status, 200);
});
