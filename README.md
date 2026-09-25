# Thunder Den QR bridge

The bridge runs on the same online computer as the
[Thunder Den-enabled async-hwi](https://github.com/bitcoinerlab/wizardsardine-async-hwi/tree/thunderden-qr).
async-hwi sends a request to the local bridge. Its browser page displays the
request QR code and uses the computer's camera to scan the reply from the
offline device running Thunder Den. Wallet policy, registration proofs and
transaction handling belong to the client. The bridge keeps one exchange in
memory and stores no wallets or camera images.

## Run (Node.js 22 or newer)

The packaged command starts the server and opens the QR page. Once published
on npm, run:

```sh
npx @bitcoinerlab/thunderden-qr-bridge
```

To run the current checkout instead:

```sh
npm ci --ignore-scripts
npm run build
npx .
```

The default port is 32123. `--port 0` chooses an available port; `--no-open` prints
the URL without launching a browser. The npm package includes the built frontend
and has no runtime npm dependencies.

With the bridge open and Thunder Den set to regtest, request an xpub through
async-hwi. The browser page displays the request QR code:

```sh
hwi --network regtest xpub get --path "m/48h/1h/0h/2h"
```

async-hwi discovers the bridge alongside other devices. Its `device list` command
retrieves the offline signer's fingerprint through QR and waits for the reply.
`xpub get` returns a bare xpub. For another port, set
the `THUNDERDEN_BRIDGE_URL` environment variable to
`http://127.0.0.1:PORT/exchange`.

For a complete wallet registration and signing example, follow the
[end-to-end walkthrough](https://github.com/bitcoinerlab/thunderden/blob/master/docs/WALKTHROUGH.md).
The [Thunder Den QR protocol](https://github.com/bitcoinerlab/thunderden/blob/master/docs/PROTOCOL.md)
describes the messages exchanged with the offline device.

Each bridge process is one signing-key session. Its first successful reply pins
the observed fingerprint. Restart the bridge before changing the seed/passphrase
or switching to another signer. A different fingerprint ends the session instead
of silently switching existing clients. Session IDs are public connection labels,
not authentication tokens or proofs of key ownership.

1. Load keys on the offline device running Thunder Den before starting the online camera.
2. Run a client command and scan the displayed request with Thunder Den.
3. Review and approve on Thunder Den. Start the response camera when its QR is ready.
4. The client validates the reply. The camera stops after delivery.

Cancel on the bridge page and press Esc on Thunder Den. Disconnecting the client
discards its pending exchange and late replies are rejected. Approval requests
are never retried automatically. This is development/test-network software.

## Local API

The service listens only on `127.0.0.1`. It trusts local programs, including other
OS users. There are no credentials. Exact Host/Origin checks,
Fetch Metadata checks and non-simple POST content types reject cross-origin
browser requests. POST bodies must use `Content-Type: application/cbor`.

- `GET /info`: the fixed text `thunderden-qr-bridge` and a fresh-per-process
  `X-Thunderden-Session` response header, for availability and session checks.
- `POST /exchange`: inner command CBOR bytes; waits for the reply bytes. Clients
  must echo `X-Thunderden-Session` and check it on the response.
- `GET /job`: the current request ID (hex) and base64 request, or `null`.
- `POST /reply/JOB_ID`: reply CBOR bytes, checked against the request ID.
- `POST /cancel/JOB_ID`: empty body; cancel the pending exchange.

HTTP 409 means busy or a mismatched job/reply; 410 means cancelled. HTTP 412 means
the client's session is stale or the signer changed. A signer change also makes
`/info` return 412 until the bridge restarts. async-hwi negotiates the session ID
automatically and rejects stale sessions without retrying requests.
The bridge checks reply-header metadata for session binding; policies and PSBTs
remain opaque. The browser adds/removes the `ur:bytes` wrapper. It does not
interpret wallet policies or approve signing. All signing approval stays on the
offline screen.

## Checks

From this directory, run the bridge's HTTP and QR tests:

```sh
npm test
```

See [developer checks](docs/DEVELOPMENT.md) for the optional Docker signer
fixture, browser simulation, npm package check and Bitcoin Core regtest run.
The signer fixture uses public test keys and is not part of the installed bridge.

## Ongoing work

A separate BHWI backend can also use this bridge, but that integration is still
development work. The bridge does not depend on BHWI.
