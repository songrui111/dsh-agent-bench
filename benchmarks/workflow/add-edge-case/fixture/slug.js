function slugify(s) {
  return s
    .match(/[a-zA-Z0-9]+/g)
    .map((word) => word.toLowerCase())
    .join('-')
}

module.exports = { slugify }
