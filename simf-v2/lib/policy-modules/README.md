# Policy modules

The blacklist policies share hashing, ordering, insertion checks, empty-tree
validation, and outpoint-key derivation in `../policy_core.simf`. The public
depth adapters are `../policy.simf`, `../policy_d5.simf`, and
`../policy_d6.simf`.

SimplicityHL 0.7.x resolves `lib` as a flat module namespace. A directory named
`policy` shadows `policy.simf`, so this documentation directory deliberately
uses `policy-modules` until directory-backed library modules are supported.

Each adapter owns only compile-time facts that cannot be abstracted today: the
fixed path-array type, fold length, capacity, and empty-tree root.
