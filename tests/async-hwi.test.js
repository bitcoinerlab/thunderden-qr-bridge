import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { cborDecode } from "@ngraveio/bc-ur/dist/cbor.js";
import { startBridge } from "../bridge.js";
import { command, runClient } from "./client.js";

test("async-hwi CLI with the C++ signer: discovery, policies, addresses and 1/5/10-input signing", {
  skip: !process.env.ASYNC_HWI_BIN, timeout: 120000,
}, async (t) => {
  const runner = process.env.TD_RUNNER || fileURLToPath(new URL("./signer-runner", import.meta.url));
  const fixture = JSON.parse((await command(runner, ["--fixtures"])).stdout);
  const origins = {};
  for (const signer of ["alice", "bob"]) {
    const bridge = await startBridge(0);
    t.after(() => new Promise((resolve) => { bridge.close(resolve); bridge.closeAllConnections(); }));
    origins[signer] = `http://127.0.0.1:${bridge.address().port}`;
  }
  const run = (signer, args, network = "regtest") => {
    const origin = origins[signer === "bob" ? "bob" : "alice"];
    return runClient({ origin, runner, signer,
      binary: process.env.ASYNC_HWI_BIN, args: ["--network", network, ...args],
      env: { ...process.env, THUNDERDEN_BRIDGE_URL: origin + "/exchange" } });
  };
  const proof = {};
  const walletArgs = (name, hmac) => ["--wallet-name", name, "--wallet-policy", fixture.descriptor, "--hmac", hmac];
  const xpubArgs = ["xpub", "get", "--path", "m/48h/1h/0h/2h"];
  const operations = (result) => result.exchanges.map(({ request }) => cborDecode(request)[3]);

  for (const signer of ["alice", "bob"]) {
    const listed = await run(signer, ["device", "list"]);
    assert.equal(listed.stderr.trim(), `${fixture[`${signer}_fingerprint`]} thunderden 0.0.1`);
    assert.deepEqual(operations(listed), [0]); // Fingerprint and version share one reply.
    const xpub = await run(signer, xpubArgs);
    assert.equal(xpub.stderr.trim(), fixture.keys[signer === "alice" ? 1 : 2].split("]")[1]);
    assert.deepEqual(operations(xpub), [1]);
    const registered = await run(signer, ["wallet", "register", "--name", fixture.name, "--policy", fixture.descriptor]);
    proof[signer] = registered.stderr.trim();
    assert.match(proof[signer], /^[0-9a-f]{64}$/);
    for (const index of [0, 17]) {
      const displayed = await run(signer, ["address", "display", "--index", String(index), ...walletArgs(fixture.name, proof[signer])]);
      assert.equal(displayed.stderr, "");
      assert.deepEqual(operations(displayed), [3]);
      assert.deepEqual(cborDecode(displayed.exchanges[0].request)[4].slice(2), [0, index]);
    }
  }
  assert.notEqual(proof.alice, proof.bob);
  const change = await run("alice", ["address", "display", "--p2tr", "m/86h/1h/0h/1/7"]);
  assert.deepEqual(operations(change), [1, 3]);
  assert.deepEqual(cborDecode(change.exchanges[1].request)[4].slice(2), [1, 7]);
  for (const tx of fixture.transactions) {
    let psbt = Buffer.from(tx.psbt_hex, "hex").toString("base64");
    for (const signer of ["alice", "bob"]) {
      const result = await run(signer, ["psbt", "sign", "--psbt", psbt, ...walletArgs(fixture.name, proof[signer])]);
      assert.deepEqual(operations(result), [4]);
      psbt = result.stderr.trim();
    }
    const verified = await command(runner, ["--verify"], { input: Buffer.from(psbt, "base64").toString("hex") + "\n" });
    assert.match(verified.stdout, /Core verified every input/);
  }
  // Each CLI and C++ runner invocation starts fresh: the saved proof must still work.
  await run("alice", ["address", "display", "--index", "3", ...walletArgs(fixture.name, proof.alice)]);
  await assert.rejects(run("alice", ["address", "display", "--index", "3", ...walletArgs(fixture.name, proof.bob)]),
    (error) => /rejected/.test(error.stderr));
  await assert.rejects(run("alice", ["address", "display", "--index", "3", ...walletArgs("renamed", proof.alice)]),
    (error) => /rejected/.test(error.stderr));
  await assert.rejects(run("decline", xpubArgs), (error) => /UserRefused/.test(error.stderr));
  await assert.rejects(run("alice", ["device", "list"], "bitcoin"), (error) => /NetworkMismatch/.test(error.stderr));

  // A detected bridge must not hide another device. Emulate only Specter's fingerprint command.
  const specter = createServer((stream) => {
    let request = "";
    stream.on("data", (chunk) => {
      request += chunk;
      if (request.trim() === "fingerprint") stream.end("ACK\nf00dbabe\n");
    });
  });
  await new Promise((resolve, reject) => specter.once("error", reject).listen(8789, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => specter.close(resolve)));
  const listed = await run("alice", ["device", "list"]);
  assert.equal(listed.stderr.trim(), `${fixture.alice_fingerprint} thunderden 0.0.1\nf00dbabe specter-simulator`);
  assert.deepEqual(operations(listed), [0]);
});
