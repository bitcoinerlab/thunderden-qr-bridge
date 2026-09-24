# QR bridge implementation and verification

Historical results for the initial implementation, including its now-removed
prototype coordinator. Current setup is in [README.md](../../README.md).

Recorded on 2026-09-24. The signer, BHWI backend, native CLI, companion and example
coordinator are implemented locally. Physical HP camera measurements and user
review of the complete workflow remain outstanding.

The roadmap was first committed in the signer repository as `057d4c6` and now
lives in [INTEGRATION_PLAN.md](INTEGRATION_PLAN.md). Implementation spans this
checkout, `../thunderden` and `../wizardsardine-bhwi` on `landabaso/thunderden-qr`.
The checks below were run against the implementation working trees before their
first feature commits. Commands below use the current QR-command naming.

The naming cleanup keeps the wire format and plain PSBT QR route intact. Its
11-suite signer run, native C++/Rust integration and three QR-image tests passed.
Fixture output, public export vectors and a `GET_INFO` reply were byte-identical
before and after the rename. BHWI changes for this cleanup were documentation-only.

The subsequent command-format simplification removes the custom key identifier
and request hash. All five BHWI checks below, all 11 signer suites, native
C++/Rust integration, QR/browser tests and real regtest broadcasts passed again.
New regressions verify that a spoofed matching fingerprint does not establish
ownership, another cosigner's proof cannot authorize signing and proof records
with the same fingerprint remain separate. Proof reuse needs no identity scan.

The later legacy-testnet mapping and development-label corrections have not been
built or tested yet, as requested. The results, payload sizes and image checksum
below describe the earlier build.

## Implemented

- Fixed-shape, bounded [Thunder Den QR commands](https://github.com/bitcoinerlab/thunderden/blob/master/docs/PROTOCOL.md#thunder-den-commands) for information, xpub,
  registration, address confirmation and PSBTv0 signing. Prototype JSON commands are retired.
- Thunder Den matches replies by request ID, operation and network and
  reports the standard master fingerprint. Full xpub checks and seed-bound HMACs
  authorize wallets. The custom key identifier and request hash have been removed.
- Unchanged wallet IDs and seed-derived proofs, including fixed three-key HTLC
  vectors and proof reuse after restarting a signer.
- Public-only `output-descriptor` and `hdkey` exports. The local summary uses
  Enter to show QR, optional details and meaningful pagination.
- Local registration/signing approval, immutable transaction review and existing
  ownership/fee/sighash checks. The new public derivation helper returns only an
  extended public key and clears its temporary private-key material.
- A sans-I/O BHWI interpreter and explicit Thunder Den context. Its native HTTP
  transport disables proxies, redirects and retries and bounds response bytes.
- Explicit native CLI selection. Ordinary background discovery starts no scans.
- A loopback-only Python service and browser QR UI with per-instance access
  control, one active job, stale-response rejection and cancellation.
- An example coordinator that saves public key records and exact wallet/proof
  data and merges checked partial PSBTs. Liana integration remains deferred.

The initial flow is wallet-driven xpub retrieval followed by registration
and signing: six scan sessions per fresh signer when the other keys are available.
The xpub reply also supplies fingerprint/version metadata. Saved records avoid a
new information scan on every later signing operation. Wallet operations can start
with the full policy and proof; no custom identity handshake is required. The
example coordinator indexes proofs by full origin+xpub records, not fingerprints.
Scanning and approval remain user-operated.

## Verified checks

### Signer

- `docker compose run --build --rm test` in `../thunderden`: **11/11 suites passed**, including QR commands,
  transaction signing, terminal interaction, export compatibility and isolation.
- C++ command tests reject malformed/truncated/non-canonical requests, wrong networks,
  wrong keys, wrong proofs, unsupported operations and missing approval callbacks.
- Independent HD-key decoding/re-encoding uses `urtypes` with the standard's new
  registry tags. Complete descriptor CBOR maps are checked separately.
- `qr-command-runner --test`: Core verifies HTLC claim/refund signatures for public
  fixtures, successive signers and adding a missing preimage without new signatures.
- The standard image build passed installed-file and repeat-assembly checks.
  The test runner is absent from the installed image.
- QEMU SeaBIOS and OVMF boots passed the actual keyboard/export flow. The resulting
  framebuffer QR matches the new BIP84 regtest descriptor export.

### BHWI

All required non-emulator commands passed:

```sh
cargo fmt --all --check
cargo clippy --all --all-features --all-targets -- -A dead_code -D warnings
cargo test --verbose --no-default-features
cargo test --verbose --color always -- --nocapture
cargo test --all --exclude "bhwi-e2e-*" --verbose --color always -- --nocapture
```

Backend regressions cover stale/mismatched headers, non-canonical replies, changed
unsigned transactions, conflicting PSBT metadata and false signing progress.

The new native C++ integration test was also run explicitly:

```sh
TD_RUNNER=/home/landabaso/bitcoinerlab/thunderden-bhwi-bridge/native-runner \
  cargo test -p bhwi-async --no-default-features --features thunderden \
  --test thunderden_native -- --ignored --nocapture
```

It passed xpub retrieval, cached metadata, both registrations, receive/change
address checks at multiple indexes, 1/5/10-input partial signing, proof reuse,
refusal and wrong-proof rejection. Final PSBT signatures were verified by Core.
No physical hardware-wallet emulator is needed for this backend: the fixture
runner executes the real signer handlers with fixed public test keys.

### Companion and coordinator

- Coordinator build, format and Clippy checks passed.
- Python service tests passed access-control, origin/host checks, size bounds,
  busy state, cancellation and late/mismatched reply handling.
- QR-image tests passed reordered/duplicate/missing-frame recovery, malformed
  streams and real C++ QR command exchanges with two-party signing.
- Chromium **152.0.7977.82** passed the actual page flow using a generated canvas
  camera: request rendering, response scanning, stale replies, camera shutdown
  and cancellation. This was not a physical webcam test.
- Real Bitcoin Core **31.1** regtest funding/spending passed through the example
  coordinator, BHWI, HTTP service and C++ handlers. Claim and delayed-preimage
  spends finalized and broadcast. A refund was rejected as `non-BIP68-final`
  before mining the required blocks, then accepted and broadcast.
- The same regtest harness exercised native `bhwi` CLI selection, xpub,
  registration, address confirmation and two-party PSBT signing.

The Core test node used a temporary data directory with networking disabled.
Its x86-64 release archive was checked against SHA256
`b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e`.

## Generated HTLC workload

`qr-command-runner --fixtures` generates these values from a validated policy and real
PSBTs. The policy has a NUMS internal key, a 2-of-2 hashlocked claim and Alice's
144-block refund using a disjoint branch pair. It includes both leaves, a
32-byte preimage and receive/change derivations.

| Inputs | Unsigned PSBT | After Alice | After Bob | Alice signatures | Bob signatures |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 1,468 B | 1,730 B | 1,861 B | 2 | 1 |
| 5 | 4,854 B | 6,164 B | 6,819 B | 10 | 5 |
| 10 | 9,084 B | 11,704 B | 13,014 B | 20 | 10 |

Alice signs both her claim and refund keys. This is why her PSBT grows more than
the earlier one-signature-per-signer estimate. Those signatures commit to the
same reviewed transaction; later finalization chooses a satisfiable script path.

Measured encoded payloads, including the UR byte-string wrapper. Removing
the extra identifier and hash saves 34 bytes per request and 68 bytes per reply:

| Inputs | Alice request/reply bytes | Alice request/reply frames | Bob request/reply bytes | Bob request/reply frames |
| --- | --- | --- | --- | --- |
| 1 | 2,087 / 1,777 | 11 / 9 | 2,349 / 1,908 | 12 / 10 |
| 5 | 5,473 / 6,211 | 28 / 32 | 6,783 / 6,866 | 34 / 35 |
| 10 | 9,703 / 11,751 | 49 / 59 | 12,323 / 13,061 | 62 / 66 |

At the nominal four frames per second, the combined source-frame airtime for
both signers is 10.5, 32.25 and 59 seconds respectively. This excludes missed
frames, aiming, startup and review. It is not measured camera throughput.

The exact policy ID is
`d4a3cc4c6b38a893fa0d41c51edfd6503e41354ded8739bfa308ef7e63ca573b`.
Public-fixture proofs are fixed in the native regression test. The C++/Rust test
independently checks the ID, including its non-power-of-two Merkle split.

## Built image

The recorded Thunder Den `thunderden.img` is **67,108,864 bytes**.
SHA256:

```text
8db022d60c556f81aa004c5e4cf279df231ec97ffadc94f3c042c55475ccd2cf
```

Its checksum and installed-file inventory were exported alongside it and checked.
The installed signer is 2,537,744 bytes and the scanner is 88,184 bytes.
This image includes the uncommitted command-format simplification after `f3677f0`.
Installed-file checks, repeat assembly and BIOS/UEFI boot/export tests passed.
It has not been flashed to or tested on the physical HP during this phase.

## Physical acceptance still needed

Use the rebuilt image and the companion instructions with test keys/funds:

1. Record cold-start camera success, first-preview failures and a scan longer than
   one minute. Try a cancelled scan followed by a fresh scan.
2. Retrieve the intended BIP48 xpub and compare the fingerprint/path on the signer.
   Register the same wallet on both intended seeds.
3. Verify a receive address and a change address against the online coordinator.
4. Complete a small two-signer PSBT, then 5- and 10-input workloads. Record capture
   time separately from policy/transaction review and screen repositioning.
5. Refuse an operation, change the loaded seed and try a late response from a
   cancelled job. Confirm clear errors and recovery to a fresh operation.
6. End the session, reload the same seed/passphrase and reuse the saved proof.
7. Check that the policy, partial result and next action are understandable on the
   actual screen. Record median and slow-case timings rather than assuming the
   analytical allowance is achieved.

Real wallet imports of the modern standalone export types, other online platforms
and the separate HP USB boot/PM investigation are not verified by these tests.
