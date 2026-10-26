function wrap(value) {
  return `<${value}>`
}

function renderA(value) {
  return 'a:' + wrap(value)
}

module.exports = { renderA }
