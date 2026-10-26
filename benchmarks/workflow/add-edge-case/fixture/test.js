const { slugify } = require('./slug.js')

let failed = 0

function check(name, got, want) {
  if (got !== want) {
    console.error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
    failed += 1
  }
}

check('basic', slugify('Hello World'), 'hello-world')
check('punctuation', slugify('a, b!'), 'a-b')

if (failed === 0) console.log('OK')
process.exit(failed === 0 ? 0 : 1)
