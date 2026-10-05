// Picks the extractor for a file by its extension. Each extractor exposes
// extract(buffer, fileName) -> { title, sections: [{ section, text, prefix? }] },
// where title is null if the file has none. prefix, if given, starts each of the
// section's chunks instead of the section name (see src/splitter.js).

const path = require('path');
const { titleFromFileName } = require('./title');
const { UploadError } = require('../upload-error');

const EXTRACTORS = {
  '.txt': require('./text'),
  '.md': require('./markdown'),
  '.pdf': require('./pdf'),
};

function getExtractor(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const extractor = EXTRACTORS[ext];
  if (!extractor) {
    const supported = Object.keys(EXTRACTORS).join(', ');
    throw new UploadError('unsupportedType', `Unsupported file type "${ext || fileName}". Supported: ${supported}`);
  }
  return extractor;
}

// Extracts a file's title and sections. Files without a title of their own
// get one made from the file name.
async function extract(fileName, buffer) {
  const { title, sections } = await getExtractor(fileName).extract(buffer, fileName);
  return { title: title || titleFromFileName(fileName), sections };
}

module.exports = { getExtractor, extract };
