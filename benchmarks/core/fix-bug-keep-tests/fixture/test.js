const { add, mul } = require('./calc.js')

let failed = 0

function check(name, got, want) {
  if (got !== want) {
    console.error(`FAIL ${name}: got ${got}, want ${want}`)
    failed += 1
  }
}

check('add', add(2, 3), 5)
check('mul', mul(2, 3), 6)

if (failed === 0) console.log('OK')
process.exit(failed === 0 ? 0 : 1)
