# Development

## Checks

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

Build the [async-hwi CLI](https://github.com/wizardsardine/async-hwi) to exercise
it through HTTP against the C++ signer. Set `ASYNC_HWI_BIN` to the path of the
compiled `hwi` command. Run this with no physical hardware wallets attached or
other simulators running:

```sh
ASYNC_HWI_BIN=/path/to/hwi node --test tests/async-hwi.test.js
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
BITCOIND=/path/to/bitcoind ASYNC_HWI_BIN=/path/to/hwi node tests/regtest.js
```

These checks use public fixtures and a temporary node with networking disabled.
Physical camera use and Liana integration require separate testing.

## Local API

The bridge runs a local HTTP server on the online computer. Both async-hwi and
the JavaScript in the bridge's browser page talk to that server. The page's
JavaScript sends its own GET and POST requests automatically; the offline signer
only exchanges QR codes. Users do not need to call these routes or copy IDs.

First, async-hwi calls `GET /info` to find the bridge. The response contains
the fixed text `thunderden-qr-bridge` and an `X-Thunderden-Session` header. This
public ID belongs to the bridge process, not to a QR request. async-hwi includes
it in `POST /exchange` and checks it on the response. The POST carries the
request's inner CBOR bytes and stays open until the bridge has an answer. Only
one exchange can be waiting at a time.

The page checks `GET /job` about every half second. The response is `null` when
idle, or an `id` in hex and `payload` in base64 for the waiting request. This
job ID comes from the request and is separate from the bridge session ID. The
page displays the payload as a `ur:bytes` QR. After the user starts the camera,
the page reads Thunder Den's reply QR, removes the QR wrapper and sends the
reply bytes to `POST /reply/JOB_ID`. The bridge checks that the reply matches
the pending request, then completes `/exchange` with HTTP 200 and those bytes.
The page gets HTTP 204 to confirm delivery. async-hwi validates the reply;
wallet policies and PSBTs remain opaque to the bridge.

Clicking **Cancel this request** makes the page send `POST /cancel/JOB_ID` with
an empty body. The page gets HTTP 204, while the waiting `/exchange` ends with
HTTP 410. This does not cancel offline review; press Esc on Thunder Den too. If
the client disconnects, the bridge drops the job and rejects late replies. It
does not retry approval requests. HTTP 409 means the bridge is busy or the job
or reply does not match.

The first successful reply binds this bridge process to its observed signing
fingerprint. A reply from a different fingerprint ends the session. HTTP 412
means the client's session is stale or the signer changed; `/info` and `/job`
also return 412 after a signer change until restart. Restart the bridge before
switching keys. Neither the fingerprint nor the public session ID authenticates
ownership of a signing key.

The service listens only on `127.0.0.1`. It trusts local programs, including
other OS users, and has no credentials. Host/Origin checks, Fetch Metadata
checks and non-simple POST content types reject cross-origin browser requests.
All POST bodies use `Content-Type: application/cbor`. The bridge inspects reply
headers for session binding but does not interpret wallet policies or approve
signing.
