const { add, sub } = require('./calc.js')

let failed = 0
if (add(2, 3) !== 5) {
  console.error('FAIL add')
  failed += 1
}
if (sub(5, 3) !== 2) {
  console.error('FAIL sub')
  failed += 1
}

if (failed === 0) console.log('OK')
process.exit(failed === 0 ? 0 : 1)
