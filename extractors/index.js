// Picks the extractor for a file by its extension. Each extractor exposes
// extract(buffer, fileName) -> [{ section, text }].

const path = require('path');

const EXTRACTORS = {
  '.txt': require('./text'),
  '.md': require('./markdown'),
};

function getExtractor(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const extractor = EXTRACTORS[ext];
  if (!extractor) {
    const supported = Object.keys(EXTRACTORS).join(', ');
    throw new Error(`Unsupported file type "${ext || fileName}". Supported: ${supported}`);
  }
  return extractor;
}

module.exports = { getExtractor };
