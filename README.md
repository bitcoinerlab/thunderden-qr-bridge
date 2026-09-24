# Thunder Den QR bridge

QR transport for the online computer. BHWI, async-hwi or another client supplies
a Thunder Den request; the bridge displays it and scans the reply. Wallet policy,
registration proofs and transaction handling belong to the client. The bridge
keeps one exchange in memory and stores no wallets or camera images.

## Run (Node.js 22 or newer)

The packaged command starts the server and opens the QR page. After npm publication:

```sh
npx @bitcoinerlab/thunderden-qr-bridge
```

For the current unpublished checkout:

```sh
npm ci --ignore-scripts
npm run build
npx .
```

The default port is 32123. `--port 0` chooses an available port; `--no-open` prints
the URL without launching a browser. The npm package includes the built frontend
and has no runtime npm dependencies. Python is not required.

- **BHWI:** `bhwi --device-type thunderden --network regtest xpub get "m/48h/1h/0h/2h"`
- **async-hwi:** `hwi --network regtest xpub get --path "m/48h/1h/0h/2h"`

async-hwi selects a running bridge before USB discovery. Its availability probe
does not start an optical exchange. For another port, set
`THUNDERDEN_BRIDGE_URL=http://127.0.0.1:PORT/exchange`; BHWI accepts
`--device-path qr:127.0.0.1:PORT`.

Both clients need their Thunder Den backend enabled. They use the same
[Thunder Den QR protocol](https://github.com/bitcoinerlab/thunderden/blob/master/docs/PROTOCOL.md).
They can share the service, with one active operation at a time.

1. Load keys on the offline laptop before starting the online camera.
2. Run a client command and scan the displayed request with Thunder Den.
3. Review and approve on Thunder Den. Start the response camera when its QR is ready.
4. The client validates the reply. The camera stops after delivery.

Cancel on the bridge page and press Esc on Thunder Den. Disconnecting the client
discards its pending exchange and late replies are rejected. Approval requests
are never retried automatically. This is development/test-network software.

## Local API

The service listens only on `127.0.0.1`. It trusts local programs, including other
OS users. There are no credentials or HTTP sessions. Exact Host/Origin checks,
Fetch Metadata checks and non-simple POST content types reject cross-origin
browser requests. POST bodies must use `Content-Type: application/cbor`.

- `GET /info`: the fixed text `thunderden-qr-bridge`, for availability checks.
- `POST /exchange`: inner command CBOR bytes; waits for the reply bytes.
- `GET /job`: the current request ID (hex) and base64 request, or `null`.
- `POST /reply/JOB_ID`: reply CBOR bytes, checked against the request ID.
- `POST /cancel/JOB_ID`: empty body; cancel the pending exchange.

HTTP 409 means busy or a mismatched job/reply; 410 means cancelled. The browser
adds/removes the `ur:bytes` wrapper. It does not interpret wallet policies or
approve signing. All signing approval stays on the offline screen.

## Checks

Build the standard Docker test image in the sibling `thunderden` checkout first.
From this directory:

```sh
TD_RUNNER="$PWD/native-runner" npm test
node --test tests/browser.test.js
node --test tests/package.test.js
```

The browser test uses Chromium and a generated camera, not a real webcam.
For regtest broadcasts through a client CLI, set `BITCOIND` to Bitcoin Core's
`bitcoind` (with `bitcoin-cli` beside it), then run one of the commands below.
The async-hwi test uses port 32123 to verify discovery without configuration.

```sh
BHWI_BIN=../wizardsardine-bhwi/target/debug/bhwi node tests/regtest.js
ASYNC_HWI_BIN=../wizardsardine-async-hwi/target/debug/hwi node tests/regtest.js
```

These tests use public fixtures and a temporary node with networking disabled.
The C++ fixture runner is never installed in the offline signer image. Physical
HP camera checks and Liana integration are separate follow-up work.
