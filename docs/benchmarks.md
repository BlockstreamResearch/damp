# AMP v0.1 maximum-shape contract metrics

Measured by `maximum_ten_input_ten_output_transfer_uses_recorded_minimal_padding`
for both an ordinary one-regulated-input transfer and the maximum
ten-regulated-input/ten-regulated-output shape. Both include the single
policy-asset fee input allowed by the signer. Each verifier consumes a fixed
zero-valued budget witness. This avoids Taproot annexes, which are
consensus-valid but non-standard under current Elements relay policy. These are
the smallest word counts for which both declared shapes need no annex.

| Verifier | Capacity | Budget words | Budget bytes | Final witness bytes | Execution milliweight | Annex bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| D4 | 16 | 278 | 8,896 | 15,835 | 15,053,549 | 0 |
| D5 | 32 | 329 | 10,528 | 18,104 | 16,617,840 | 0 |
| D6 | 64 | 380 | 12,160 | 20,408 | 18,368,883 | 0 |

The ordinary transfer fixtures are respectively 12,624 / 12,668,815,
14,317 / 14,340,306, and 16,045 / 16,091,349 witness bytes / execution
milliweight for D4, D5, and D6.

These values are deterministic fixtures for Simplex 0.0.9 and the pinned
`simplicityhl-std` revision. An intentional compiler or contract change must
update the test and this table together.
