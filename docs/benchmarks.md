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
| D4 | 16 | 295 | 9,440 | 16,762 | 16,759,051 | 0 |
| D5 | 32 | 346 | 11,072 | 19,048 | 18,460,558 | 0 |
| D6 | 64 | 397 | 12,704 | 21,320 | 20,195,857 | 0 |

The ordinary transfer fixtures are respectively 13,553 / 13,440,589,
15,262 / 15,142,096, and 16,958 / 16,877,395 witness bytes / execution
milliweight for D4, D5, and D6.

These values are deterministic fixtures for Simplex 0.0.9 and the pinned
`simplicityhl-std` revision. An intentional compiler or contract change must
update the test and this table together.
