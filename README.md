# Thunder Den QR bridge

[Thunder Den](https://github.com/bitcoinerlab/thunderden) turns a computer
booted from USB into an offline Bitcoin signer. You enter recovery words and
review addresses or transactions on that computer. Requests and replies travel
between it and your online computer as QR codes.

On the online computer, [async-hwi](https://github.com/wizardsardine/async-hwi)
gives wallet software a common way to ask signing devices for public keys,
address checks and transaction signatures. It is a Rust library with a
command-line tool. It can make Thunder Den requests, but those requests still
need to reach the offline signer.

This bridge handles that journey. It runs alongside async-hwi on the same
online computer and opens a browser page to show each request as a QR code.
Thunder Den scans the request, and you review signing on its own screen. When
it shows a reply QR, point the online computer's camera at it. The bridge
returns that reply to async-hwi. It only transports messages: it does not build
transactions or store wallets or camera images.

## Run (Node.js 22 or newer)

Build async-hwi's `hwi` command, then run it and the bridge on the same online
computer.

Start the bridge to open the QR page:

```sh
npx @bitcoinerlab/thunderden-qr-bridge
```

To run from a checkout instead:

```sh
npm ci --ignore-scripts
npm run build
npx .
```

The default port is 32123. `--port 0` chooses an available port; `--no-open` prints
the URL without launching a browser. The npm package includes the built frontend
and has no runtime npm dependencies.

With the bridge open and Thunder Den set to regtest, request an extended public
key (xpub) through async-hwi. The browser page displays the request QR code:

```sh
hwi --network regtest xpub get --path "m/48h/1h/0h/2h"
```

The command waits while you scan the request QR with Thunder Den. Review the
request on the offline device. When its reply QR is ready, click **Start response
camera** on the bridge page and point the online computer's camera at it. The
bridge delivers the scanned reply to async-hwi so the command can finish
without you copying anything between programs.

async-hwi discovers the bridge alongside other devices. Its `device list` command
retrieves the offline signer's fingerprint through QR and waits for the reply.
`xpub get` returns a bare xpub. For another port, set
the `THUNDERDEN_BRIDGE_URL` environment variable to
`http://127.0.0.1:PORT/exchange`.

The bridge handles one request at a time. To cancel, click **Cancel this request**
on its page and press Esc on Thunder Den too; cancelling on one computer does
not stop the other. Requests are not retried automatically. Restart the bridge
before changing the seed/passphrase or switching to another signer.

For wallet registration and signing, follow the
[end-to-end walkthrough](https://github.com/bitcoinerlab/thunderden/blob/master/docs/WALKTHROUGH.md).
The [QR protocol](https://github.com/bitcoinerlab/thunderden/blob/master/docs/PROTOCOL.md)
describes the messages exchanged with Thunder Den. The
[local API notes](docs/DEVELOPMENT.md#local-api) explain the bridge's internal
HTTP flow and session behavior.

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
