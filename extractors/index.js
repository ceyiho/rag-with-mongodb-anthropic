// Picks the extractor for a file by its extension. Each extractor exposes
// extract(buffer, fileName) -> { title, sections: [{ section, text }] },
// where title is null if the file has none.

const path = require('path');

const EXTRACTORS = {
  '.txt': require('./text'),
  '.md': require('./markdown'),
};

// Lowercase in titles, except as the first word.
const SMALL_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'on', 'or',
  'the', 'to', 'vs', 'with',
]);

function getExtractor(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const extractor = EXTRACTORS[ext];
  if (!extractor) {
    const supported = Object.keys(EXTRACTORS).join(', ');
    throw new Error(`Unsupported file type "${ext || fileName}". Supported: ${supported}`);
  }
  return extractor;
}

// Extracts a file's title and sections. Files without a title of their own
// get one made from the file name.
async function extract(fileName, buffer) {
  const { title, sections } = await getExtractor(fileName).extract(buffer, fileName);
  return { title: title || titleFromFileName(fileName), sections };
}

// "nimbus-release-notes.txt" -> "Nimbus Release Notes". Letters that are already
// uppercase are kept, so "MongoDB-guide.md" -> "MongoDB Guide".
function titleFromFileName(fileName) {
  const words = path.basename(fileName, path.extname(fileName)).split(/[-_\s]+/).filter(Boolean);
  const title = words.map((word, i) => (i > 0 && SMALL_WORDS.has(word.toLowerCase())
    ? word.toLowerCase()
    : word[0].toUpperCase() + word.slice(1))).join(' ');
  return title || fileName;
}

module.exports = { getExtractor, extract };
