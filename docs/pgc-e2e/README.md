# Native confidential audit v2 evidence

Status: the requested experimental DAMP v0.2 implementation and its scoped regtest and Liquid testnet lifecycles are verified. This is research software, not a mainnet or production-custody claim.

## Implemented behavior

- Ordinary transfers are autonomous. The issuer never approves or co-signs them.
- Every regulated output carries a covenant-verified native audit proof tied to the actual Elements value commitment, output index, asset, deployment, audit epoch, script, auxiliary bytes, and `sig_all_hash`.
- With audit public key `P = sG`, native commitment `C = vH + bG`, and handle `D = bP`, the issuer computes `C - s^-1 D = vH`. Authenticated auxiliary data normally recovers `(v,b)` immediately; invalid or missing data leaves the current transfer valid and can require bounded or expensive discrete-log recovery.
- Application construction accepts `1..=2^63-1` base units. The native `[1,2^63]` proof endpoint is accepted by the covenant and reported truthfully as outside the application cap. All supply arithmetic and JSON reporting use wider/arbitrary-precision values.
- The issuer alone reissues. Reissuance first pays issuer-owned confidential outputs whose openings are exported offline, then those outputs move through ordinary audited transfers.
- Policy blocks apply to one exact output outpoint. A recovery-data finding can draft that output for a future policy update; it does not undo a confirmed transfer, identify intent, blame a recipient, or create an owner-wide block.

The local report service receives a deployment-scoped audit secret, a separate issuer-certified report key, public holder address data, and commitment-checked issuer issuance openings. It does not receive a mnemonic, governance key, holder spending key, reissuance token key, or any spending operation. Credentials are plaintext owner-only JSON and must remain mode `0600` on an issuer-controlled host.

## Network evidence

| Evidence | Verified result |
| --- | --- |
| [Ordinary regtest lifecycle](regtest.json) | Confidential bootstrap, two autonomous hops, issuer-only reissuance, exact-output policy block, blocked spend rejection, unrelated issuer output spend, and signed `1100 = 1100` conservation report |
| [Boundary regtest lifecycle](regtest-boundary.json) | Initial and reissued amounts at `2^63-1`; confidential splitting; aggregate `18446744073709551714 = 2*(2^63-1)+100` without wrapping |
| [Adversarial regtest lifecycle](regtest-adversarial.json) | Unmodified verifier/node accepts native endpoint `2^63`; production SDK rejects constructing it; missing/invalid auxiliary transfers remain valid; bounded recovery succeeds or exhausts without inventing an amount; mutated witnesses reject |
| [Liquid testnet lifecycle](liquid-testnet.json) | Confirmed funding normalization, v0.2 bootstrap, autonomous issuer/recipient transfers, issuer reissuance, exact-output block, blocked spend rejection, audited distribution to the same recipient, and signed conservation report |

Key Liquid testnet transactions include bootstrap `9d7adbc591880f8857ed898961f6916a70d2ec6d94cfb72d923cb69a71ce1acb`, autonomous transfers `fd2e7f22dae3ea0a9e7e43349988a9f55e874a39987b62c58797e4c520a13453` and `a89534038e9b05e986662f691e06ddd9657594ee847793a8bbbfc739facd9b48`, issuer reissuance `91233692c8b5c9dd0b50471bf9e54a3e41f03f41191a90aeac9376363e224b94`, policy block `8d4b16c544d1b357a2f95b8ae67c7c7da47099554ece724475d262843673c020`, and post-reissuance audited distribution `db54862ab716d63c84f708122ece945dacaed8ec004c0f2c10f955e14b378edc`.

Regtest enabled non-standard transaction relay for the pinned TapSimplicity policy. Its high-issuance boundary run also enabled `acceptunlimitedissuances=1`, the Elements relay setting used to exercise consensus amounts above the ordinary regtest issuance policy. The Liquid testnet run used the public network's normal relay behavior and ordinary test amounts; the high-value boundary was not broadcast there.

## Report and UI verification

The report service scans linked blocks from bootstrap through a confirmation-bounded snapshot, re-executes the actual covenant witness, validates every native proof and auxiliary record, records every issuance, checks live output status where snapshot semantics permit, and signs canonical JSON with the certified report key. Unexpected governance, unknown policy successors, off-anchor issuance/value, unavailable openings, covenant failure, reorg, provider inconsistency, unresolved amounts, or conservation mismatch prevent `complete: true`.

The web UI verifies the issuer certificate first, then the exact report bytes with the certified key. It binds the report to the selected deployment/network and uses the report's exact policy root for a blocklist draft. Desktop and 390px mobile Playwright checks covered the real signed service response, download, invalid bearer token, report-signature mutation, certificate-signature mutation, localhost endpoint restriction, console health, and horizontal overflow.

## Deliberate limits

- One report scans at most 256 blocks, 10,000 transactions, 512 anchor transitions, 128 supplied policies, and a 32 MiB/1,024-entry transaction cache. Older deployments need a dedicated indexed provider.
- Chain inclusion trusts one configured provider. Linked-block and separate outspend endpoints are consistency checks from that same provider, not independent-provider evidence or an SPV proof.
- Public Liquid testnet Esplora queries reveal requested transaction identifiers to Blockstream. Use a private Elements node for private indexing.
- HTTP recovery caps bounded DLP at `2^20`; the native library permits at most `2^32` and bounds table memory. Exhaustion reports an unknown amount. Complete malicious full-interval recovery can remain expensive.
- Audit, report, governance, and holder keys are distinct derivation roles, but the offline export currently derives them from one issuer recovery phrase. Compromise of that root compromises every role.
- Native proof hashing uses 4,096 budget words. Measured one-output execution is about 124.5 million milliweight; size/cost is operational evidence, not a security argument.
- Governance can deliberately end coverage. The report labels any movement that is not an exact policy transition or issuer reissuance-to-self as unexpected and incomplete.

## Reproduction

Run `cargo test -p simplicity-amp-core -p simplicity-amp-signer`, `simplex test`, `python3 scripts/test-pgc-audit-service.py`, `pnpm test`, `pnpm typecheck`, `pnpm build`, `python3 scripts/check-contract-bundle-v2.py`, and the validation scripts in `scripts/`. The regtest/testnet drivers persist private operation material before broadcast and safely resume by checking raw transaction existence.

Testnet drivers require separately funded disposable testnet credentials. Keep
wallet material and report-service secrets outside the repository. The committed
JSON files contain public lifecycle evidence, not credentials. Running a driver
can broadcast transactions; ordinary unit and build checks do not require it.
