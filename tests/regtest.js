// Core funding, CLI/HTTP signing, broadcast and CSV maturity. Public fixtures only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { startBridge } from "../bridge.js";
import { command, runClient } from "./client.js";

async function main() {
  const { BITCOIND: bitcoind, BHWI_BIN: bhwi, ASYNC_HWI_BIN: asyncHwi } = process.env;
  assert.ok(bitcoind, "Set BITCOIND");
  assert.ok(Boolean(bhwi) !== Boolean(asyncHwi), "Set exactly one of BHWI_BIN or ASYNC_HWI_BIN");
  const bitcoinCli = join(dirname(bitcoind), "bitcoin-cli");
  const runner = process.env.TD_RUNNER || fileURLToPath(new URL("./signer-runner", import.meta.url));
  const fixture = JSON.parse((await command(runner, ["--fixtures"])).stdout);
  // Exercise async-hwi's zero-configuration default endpoint.
  const bridges = { alice: await startBridge(asyncHwi ? 32123 : 0), bob: await startBridge(0) };
  const root = await mkdtemp(join(tmpdir(), "thunderden-regtest-"));
  const reservation = createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const daemon = spawn(bitcoind, ["-regtest", `-datadir=${root}`, `-rpcport=${port}`,
    "-server=1", "-listen=0", "-networkactive=0", "-fallbackfee=0.0001"], { stdio: ["ignore", "ignore", "inherit"] });
  const exited = once(daemon, "exit");
  exited.catch(() => {});

  async function rpc(method, ...params) {
    const { stdout } = await command(bitcoinCli, ["-regtest", `-datadir=${root}`, `-rpcport=${port}`, "-rpcwallet=miner",
      method, ...params.map((p) => typeof p === "string" ? p : JSON.stringify(p))]);
    try { return JSON.parse(stdout); } catch { return stdout.trim(); }
  }
  async function run(signer, operation, { proof, index = 0, change = false, psbt, output } = {}) {
    const bridge = bridges[signer];
    const origin = `http://127.0.0.1:${bridge.address().port}`;
    let args;
    if (bhwi) {
      args = ["--network", "regtest", "--device-type", "thunderden", "--device-path", `qr:127.0.0.1:${bridge.address().port}`];
      if (operation === "xpub") args.push("xpub", "get", "m/48h/1h/0h/2h");
      else if (operation === "register") args.push("register-wallet", "--name", fixture.name, "--descriptor", fixture.descriptor);
      else if (operation === "address") {
        args.push("address", "get", "--from-descriptor", fixture.name, "--wallet-descriptor", fixture.descriptor, "--hmac", proof, "--index", String(index), "--display");
        if (change) args.push("--change");
      } else args.push("sign-psbt", "--psbt", psbt, "--name", fixture.name, "--descriptor", fixture.descriptor, "--hmac", proof, "--output", output);
    } else {
      args = ["--network", "regtest"];
      if (operation === "xpub") args.push("xpub", "get", "--path", "m/48h/1h/0h/2h");
      else if (operation === "register") args.push("wallet", "register", "--name", fixture.name, "--policy", fixture.descriptor);
      else {
        args.push(...(operation === "address" ? ["address", "display", "--index", String(index)] : ["psbt", "sign", "--psbt", await readFile(psbt, "utf8")]));
        args.push("--wallet-name", fixture.name, "--wallet-policy", fixture.descriptor, "--hmac", proof);
      }
    }
    const env = { ...process.env };
    delete env.THUNDERDEN_BRIDGE_URL;
    if (asyncHwi && signer === "bob") env.THUNDERDEN_BRIDGE_URL = origin + "/exchange";
    const { stdout, stderr } = await runClient({ origin, binary: bhwi || asyncHwi, args, signer, runner, env });
    const result = (bhwi ? stdout : stderr).trim();
    if (asyncHwi && operation === "sign") await writeFile(output, result);
    return result;
  }
  try {
    const deadline = Date.now() + 20000;
    for (;;) {
      try { await rpc("getblockchaininfo"); break; }
      catch { assert.ok(daemon.exitCode === null && Date.now() < deadline, "Core did not start"); await delay(100); }
    }
    await rpc("createwallet", "miner");
    const mine = await rpc("getnewaddress");
    await rpc("generatetoaddress", 101, mine);
    const proofs = {};
    for (const name of ["alice", "bob"]) {
      const xpub = await run(name, "xpub");
      const key = fixture.keys[name === "alice" ? 1 : 2];
      assert.equal(xpub, key.slice(key.indexOf("]") + 1));
      proofs[name] = await run(name, "register");
      assert.match(proofs[name], /^[0-9a-f]{64}$/);
    }
    assert.notEqual(proofs.alice, proofs.bob);
    const template = fixture.descriptor.split("#")[0];
    const receiveDesc = (await rpc("getdescriptorinfo", template.replaceAll("/<0;1>/*", "/0/*").replaceAll("/<2;3>/*", "/2/*"))).descriptor;
    const changeDesc = (await rpc("getdescriptorinfo", template.replaceAll("/<0;1>/*", "/1/*").replaceAll("/<2;3>/*", "/3/*"))).descriptor;
    const [receive] = await rpc("deriveaddresses", receiveDesc, [0, 0]);
    const [change] = await rpc("deriveaddresses", changeDesc, [3, 3]);
    assert.equal(await run("alice", "address", { proof: proofs.alice }), bhwi ? receive : "");
    // The async-hwi CLI displays receive addresses; async-hwi.test.js covers BIP86 change.
    assert.equal(await run("bob", "address", { proof: proofs.bob, change: Boolean(bhwi), index: 3 }), bhwi ? change : "");
    console.log("PASS: CLI selection, xpub, registration and address confirmation");

    async function preimage(psbt) {
      const { stdout } = await command(runner, ["--preimage"], { input: Buffer.from(psbt, "base64").toString("hex") + "\n" });
      return Buffer.from(stdout.trim(), "hex").toString("base64");
    }
    for (const scenario of ["claim", "delayed-preimage", "refund"]) {
      const funding = await rpc("sendtoaddress", receive, "0.001");
      await rpc("generatetoaddress", 1, mine);
      const tx = await rpc("decoderawtransaction", (await rpc("gettransaction", funding)).hex);
      const index = tx.vout.find((out) => out.scriptPubKey.address === receive).n;
      const destination = await rpc("getnewaddress");
      let psbt = await rpc("createpsbt", [{ txid: funding, vout: index, sequence: scenario === "refund" ? 144 : 0xfffffffd }],
        [{ [destination]: 0.0008 }, { [change]: 0.00019 }], 0, true);
      psbt = await rpc("utxoupdatepsbt", psbt, [{ desc: receiveDesc, range: [0, 10] }, { desc: changeDesc, range: [0, 10] }]);
      if (scenario === "claim") psbt = await preimage(psbt);
      let incoming = join(root, `${scenario}.psbt`);
      await writeFile(incoming, psbt);
      for (const name of scenario === "refund" ? ["alice"] : ["alice", "bob"]) {
        const output = join(root, `${scenario}-${name}.psbt`);
        await run(name, "sign", { proof: proofs[name], psbt: incoming, output });
        incoming = output;
      }
      let signed = await readFile(incoming, "utf8");
      if (scenario === "delayed-preimage") {
        assert.equal((await rpc("finalizepsbt", signed)).complete, false);
        signed = await preimage(signed);
      }
      const final = await rpc("finalizepsbt", signed);
      assert.equal(final.complete, true, scenario);
      let [accepted] = await rpc("testmempoolaccept", [final.hex]);
      if (scenario === "refund") {
        assert.equal(accepted.allowed, false);
        assert.match(accepted["reject-reason"], /non-BIP68-final/);
        await rpc("generatetoaddress", 144, mine);
        [accepted] = await rpc("testmempoolaccept", [final.hex]);
      }
      assert.equal(accepted.allowed, true, JSON.stringify(accepted));
      await rpc("sendrawtransaction", final.hex);
      await rpc("generatetoaddress", 1, mine);
      console.log(`PASS: ${scenario} through client CLI -> Node bridge -> C++ signer -> Core broadcast`);
    }
  } finally {
    daemon.kill();
    const timer = setTimeout(() => daemon.kill("SIGKILL"), 10000);
    await exited.finally(() => clearTimeout(timer));
    for (const bridge of Object.values(bridges))
      await new Promise((resolve) => { bridge.close(resolve); bridge.closeAllConnections(); });
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
