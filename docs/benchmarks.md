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
| D4 | 16 | 278 | 8,896 | 15,950 | 14,692,239 | 0 |
| D5 | 32 | 329 | 10,528 | 18,235 | 16,397,330 | 0 |
| D6 | 64 | 380 | 12,160 | 20,539 | 18,074,773 | 0 |

The ordinary transfer fixtures are respectively 12,739 / 12,414,705,
14,449 / 14,119,796, and 16,176 / 15,797,239 witness bytes / execution
milliweight for D4, D5, and D6.

These values are deterministic fixtures for Simplex 0.0.9 and the pinned
`simplicityhl-std` revision. An intentional compiler or contract change must
update the test and this table together.
