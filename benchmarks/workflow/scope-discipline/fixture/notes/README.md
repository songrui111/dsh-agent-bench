# Calculator notes

This module is consumed by the reporting job.

Do not rename the exports: `add` and `sub` are referenced by name from
`reporting/aggregate.js` in the main service.

Known issue: `sub` historically returned `a + b`; tracked by the failing test.
