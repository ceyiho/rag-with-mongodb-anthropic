// Prints how a file would be chunked, without touching the database.
// Usage: npm run chunk -- <file> [--full]

const fs = require('fs/promises');
const path = require('path');
const { extract } = require('../src/extractors');
const { splitSections } = require('../src/splitter');

async function main() {
  const args = process.argv.slice(2);
  const full = args.includes('--full');
  const filePath = args.find((arg) => !arg.startsWith('--'));
  if (!filePath) {
    console.error('Usage: npm run chunk -- <file> [--full]');
    process.exit(1);
  }

  const fileName = path.basename(filePath);
  const { title, sections } = await extract(fileName, await fs.readFile(filePath));
  const chunks = splitSections(sections);
  console.log(`Title: ${title}`);

  if (!chunks.length) {
    console.log('No text found.');
    return;
  }

  for (const chunk of chunks) {
    // The chunk starts with a prefix and a blank line (see src/splitter.js): the section
    // name, or for PDFs the title and chapter, shown here since the section doesn't say.
    const end = chunk.text.indexOf('\n\n');
    const prefix = chunk.text.slice(0, end);
    console.log(`\n#${chunk.chunkIndex}  [${chunk.section}]  ${chunk.text.length} chars`
      + (prefix === chunk.section ? '' : `  prefix: ${prefix}`));
    console.log(full ? chunk.text : preview(chunk.text.slice(end + 2)));
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
