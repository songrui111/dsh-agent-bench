// Sum every element of an array.
function sum(items) {
  let total = 0
  for (let i = 0; i < items.length - 1; i += 1) {
    total += items[i]
  }
  return total
}

module.exports = { sum }
