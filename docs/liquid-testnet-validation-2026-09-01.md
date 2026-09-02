# Liquid testnet validation — 2026-09-01

## Scope

This record closes the funded Liquid testnet gate for the core DAMP proof of
concept. It covers a newly generated disposable debug signer, public-faucet
funding, DAMP's pre-broadcast validation and signing path, public Esplora
broadcast, chain confirmation, and the Issuer Console's confirmation check.

The flow ran from the `dev` working tree at
`a70dfc9737fccf1c00c5f68f61a1b2dcc47a550e`. The signer fingerprint was
`afd839a4`. No mnemonic, private key, existing wallet identifier, mainnet asset,
or real funds were used or recorded.

## Funding

The DAMP wallet derived two unused Liquid testnet funding addresses for the
disposable signer. Opening each DAMP-generated `liquidtestnet.com` faucet URL
returned 100,000 testnet sats:

- `afe62b191534cd09364c602d2f002ced7e3df7f53b860a9a4ef604847b5a3784`
- `d08b349f9e8a833bdcf8ec2597de1b4e92d6a5c1c674652af26bc9eaf6786e35`

Both transactions confirmed in Liquid testnet block `2598266`, hash
`bd6eaf74142d38456d4b8476c21d1e083564b1e3c88b4978f8d832b7e7eb7001`,
at `2026-09-01T08:44:07Z`. DAMP's wallet synchronization then reported two
confirmed outputs totaling `0.002 L-BTC` and enabled issuance review.

## Issuance and broadcast

DAMP reviewed, signed, and broadcast a fixed-supply test deployment:

- Issuance transaction:
  [`39faa5b530fdaa36d3791abae6694c16513eaec0378be9f0a040d3c17d79dc6f`](https://blockstream.info/liquidtestnet/tx/39faa5b530fdaa36d3791abae6694c16513eaec0378be9f0a040d3c17d79dc6f)
- Regulated asset:
  [`72a2072328ee7822b3feecbe9049b507f9ce45fe51b09cf70652d805c6f2cb06`](https://blockstream.info/liquidtestnet/asset/72a2072328ee7822b3feecbe9049b507f9ce45fe51b09cf70652d805c6f2cb06)
- Display/base-unit supply: `1,000 DLT` / `1,000`
- Verifier asset: `f5cb93d7438c8d0c37d1075676bdcab30f9889e05762932420deb8df650decad`
- Verifier issuance and anchor amount: `1`
- Explicit network fee: `500 sats`
- Deployment ID:
  `f526b8573483784a0f2401fc716d3e9f3cac642b2a76a50af1982b243fb2859d`

Public Esplora decoded both faucet transactions as the two issuance inputs,
the `1,000`-unit regulated issuance, the one-unit verifier issuance, their
Taproot outputs, two L-BTC change outputs, and the `500 sat` fee output. The
issuance confirmed in block `2598267`, hash
`0b0ffbda7b7b855917677f072c5ea6e5bc081189c85f6ea53f45121a3293714c`,
at `2026-09-01T08:45:07Z`.

## Application evidence

Before signing, the Issuer Console showed Liquid testnet, two confirmed funding
outputs totaling `0.002 L-BTC`, a `500 sat` fee, `1,000 DLT`, and the signer
holder covenant as the regulated-asset destination. After broadcast, it showed
the same issuance transaction and asset ID. Its live confirmation action then
reported `1 confirmation` and `Confirmation verified`. The browser recorded no
warning or error console entries during the live flow.

The confirmed canonical registry paths prepared by the application were:

- `deployments/f526b8573483784a0f2401fc716d3e9f3cac642b2a76a50af1982b243fb2859d.json`
- `policies/f526b8573483784a0f2401fc716d3e9f3cac642b2a76a50af1982b243fb2859d/dfbce6e60914851c845787fd8efb94a38b7d98f416b661e8e932c27c7710243e.json`

## Independent single-input split path

A separate disposable signer independently exercised the one-faucet-input path
that the direct two-input run did not cover. Faucet transaction
`ad3d949a499ee7212ee5868bd3894a4dc1f61a2cc1ac70cee3ac5762b5d1bdf8`
funded `100,000` testnet sats and confirmed in block `2598262`. DAMP detected
that issuance had only one suitable confirmed input and required its reviewed
wallet-only split instead of requesting another faucet output.

DAMP signed and broadcast split transaction
[`9c412a67645d6b2eedd1390c8394772b09547429ac2b937e14728a072fa2062e`](https://blockstream.info/liquidtestnet/tx/9c412a67645d6b2eedd1390c8394772b09547429ac2b937e14728a072fa2062e).
Public Esplora confirms one input, two confidential signer-owned L-BTC outputs,
the explicit `500 sat` fee output, and confirmation in block `2598263`. The
Issuer Console automatically detected both confirmed outputs and enabled
issuance review.

The resulting bootstrap transaction
[`d86595dbdab14350f2880984ef86af51f2c33b501c907baa023bdbf6ea9884ab`](https://blockstream.info/liquidtestnet/tx/d86595dbdab14350f2880984ef86af51f2c33b501c907baa023bdbf6ea9884ab)
confirmed in block `2598265`, hash
`7a4a630134fff271ee8aed43f966147eeb3d3ed5cca1285afc507cdc843339d4`.
Public Esplora confirms two inputs, five outputs, the explicit `500 sat` fee,
one unit of verifier asset
`5ce41f65eb9b885d357b526f20bc7325e31fd483385251f422400230dfad9721`,
`100` units of regulated asset
`0345f3cd9b4536d89f843486c0f6613d791261de46e313d3e3c5ef103055dddc`,
and two confidential L-BTC change outputs. The application verified one
confirmation and prepared these canonical paths:

- `deployments/cdda2641960fee4b5595dcfd548d311544201ed3a5d1e95eec4513af0bd9c1e4.json`
- `policies/cdda2641960fee4b5595dcfd548d311544201ed3a5d1e95eec4513af0bd9c1e4/317d51603bb598f13ef0e5dda96725546674492d5f9c7b2a6f8e9c059385d5ef.json`

## Boundary

This validation proves that both supported funding shapes and the resulting
bootstrap transaction can be discovered, validated, signed, broadcast, and
confirmed through the live Liquid testnet services used by the application.
The disposable deployments were not published
to the canonical GitHub registry because this run did not authorize a commit,
push, or unrelated public registry change. Transfer, policy-update, and
reissuance scenarios remain covered by the already-passing Elements regtest
suite; this run did not duplicate those flows with a public unpublished test
deployment.
