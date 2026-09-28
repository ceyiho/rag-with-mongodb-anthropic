// Uploads a file from the command line: saves the upload and its chunks to Atlas.
// Usage: npm run ingest -- <file>

const fs = require('fs/promises');
const path = require('path');
const { connect } = require('../src/db');
const { ingest } = require('../src/ingest');

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: npm run ingest -- <file>');
    process.exit(1);
  }

  const fileName = path.basename(filePath);
  const buffer = await fs.readFile(filePath);
  const { client, db } = await connect();

  try {
    const { uploadId, chunkCount } = await ingest(db, fileName, buffer);
    console.log(`Saved "${fileName}": ${chunkCount} chunk(s), uploadId ${uploadId}`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
