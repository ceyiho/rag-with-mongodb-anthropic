// Prints how a file would be chunked, without touching the database.
// Usage: npm run chunk -- <file> [--full]

const fs = require('fs/promises');
const path = require('path');
const { getExtractor } = require('./extractors');
const { splitSections } = require('./splitter');

async function main() {
  const args = process.argv.slice(2);
  const full = args.includes('--full');
  const filePath = args.find((arg) => !arg.startsWith('--'));
  if (!filePath) {
    console.error('Usage: npm run chunk -- <file> [--full]');
    process.exit(1);
  }

  const fileName = path.basename(filePath);
  const extractor = getExtractor(fileName);
  const sections = await extractor.extract(await fs.readFile(filePath), fileName);
  const chunks = splitSections(sections);

  if (!chunks.length) {
    console.log('No text found.');
    return;
  }

  for (const chunk of chunks) {
    console.log(`\n#${chunk.chunkIndex}  [${chunk.section}]  ${chunk.text.length} chars`);
    console.log(full ? chunk.text : preview(chunk.text.slice(chunk.section.length + 2)));
  }

  const lengths = chunks.map((chunk) => chunk.text.length);
  const average = Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length);
  console.log(`\n${sections.length} section(s), ${chunks.length} chunk(s). ` +
    `Length min ${Math.min(...lengths)}, avg ${average}, max ${Math.max(...lengths)}.`);
}

// First and last 80 characters of a chunk's body, on one line.
function preview(text) {
  const oneLine = text.replace(/\s+/g, ' ');
  return oneLine.length <= 170 ? oneLine : `${oneLine.slice(0, 80)} … ${oneLine.slice(-80)}`;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
