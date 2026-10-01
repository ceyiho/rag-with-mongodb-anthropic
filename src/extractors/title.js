// Makes a title from a file name, for files without a title of their own.

const path = require('path');

// Lowercase in titles, except as the first word.
const SMALL_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'on', 'or',
  'the', 'to', 'vs', 'with',
]);

// "nimbus-release-notes.txt" -> "Nimbus Release Notes". Letters that are already
// uppercase are kept, so "MongoDB-guide.md" -> "MongoDB Guide".
function titleFromFileName(fileName) {
  const words = path.basename(fileName, path.extname(fileName)).split(/[-_\s]+/).filter(Boolean);
  const title = words.map((word, i) => (i > 0 && SMALL_WORDS.has(word.toLowerCase())
    ? word.toLowerCase()
    : word[0].toUpperCase() + word.slice(1))).join(' ');
  return title || fileName;
}

module.exports = { titleFromFileName };
