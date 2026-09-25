# Developer checks

Run these commands from the bridge checkout. `npm ci --ignore-scripts` installs
the development tools. `npm test` builds the browser bundle and runs the bridge
HTTP and QR tests without Thunder Den, Docker or a camera:

```sh
npm ci --ignore-scripts
npm test
```

The optional `tests/signer-runner` script starts Thunder Den's C++ test runner
inside Docker with public fixture keys. Build the standard Docker test image in
the sibling `thunderden` checkout first. The first build can take a while.
The runner is not shipped in the npm package or installed on the offline device.

```sh
TD_RUNNER="$PWD/tests/signer-runner" node --test tests/qr.test.js
```

Build the [Thunder Den-enabled async-hwi CLI](https://github.com/bitcoinerlab/wizardsardine-async-hwi/tree/thunderden-qr)
in its sibling checkout to exercise it through HTTP against the C++ signer.
Run this with no physical hardware wallets attached or other simulators running:

```sh
ASYNC_HWI_BIN=../wizardsardine-async-hwi/target/debug/hwi node --test tests/async-hwi.test.js
```

This checks fingerprint discovery, xpubs, registration, receive addresses,
BIP86 change, proof reuse, refusal, wrong proofs and networks as well as
1/5/10-input signing. It also checks discovery alongside a simulated Specter on port 8789.
Two-signer tests use a separate bridge session for each signing key.

The browser test needs Chromium. It uses a generated camera stream, not a real
webcam. The package check packs the browser bundle and runs it through `npx`
with an empty offline cache:

```sh
node --test tests/browser.test.js
node --test tests/package.test.js
```

To test funding, signing and broadcasting on an isolated regtest node, set
`BITCOIND` to Bitcoin Core's `bitcoind` with `bitcoin-cli` beside it. The async-hwi
CLI uses port 32123 for Alice to check zero-configuration discovery and a
separate bridge session for Bob:

```sh
BITCOIND=/path/to/bitcoind ASYNC_HWI_BIN=../wizardsardine-async-hwi/target/debug/hwi node tests/regtest.js
```

These checks use public fixtures and a temporary node with networking disabled.
Physical camera use and Liana integration require separate testing.
