# parseRange spec

`parseRange(spec)` turns a compact range string into an array of numbers.

## Rules

1. `"1-3"` means an inclusive range: returns `[1, 2, 3]`.
2. A single number `"5"` returns `[5]`.
3. A reversed range like `"3-1"` is invalid: throw an `Error`.
4. Anything else that is not a number or a `a-b` range (for example `"abc"`,
   `""`, `"1-"`) is invalid: throw an `Error`.
5. Output array elements are numbers, not strings.

## Module shape

```js
function parseRange(spec) { /* ... */ }
module.exports = { parseRange }
```
