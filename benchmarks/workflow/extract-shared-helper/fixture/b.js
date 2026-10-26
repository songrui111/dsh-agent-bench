function wrap(value) {
  return `<${value}>`
}

function renderB(value) {
  return 'b:' + wrap(value)
}

module.exports = { renderB }
