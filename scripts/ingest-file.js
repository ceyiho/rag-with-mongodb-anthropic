// Uploads a file from the command line: saves the upload and its chunks to Atlas, then
// waits until all its chunks are searchable and sets searchableAt (src/readiness.js),
// so it is included in "All uploads" straight away.
// Usage: npm run ingest -- <file>
// Ctrl+C while waiting is safe: the upload is saved, and npm run setup sets searchableAt
// later.

const fs = require('fs/promises');
const path = require('path');
const { connect } = require('../src/db');
const config = require('../src/config');
const { ingest } = require('../src/ingest');
const { checkReadiness } = require('../src/readiness');

const CHECK_EVERY_MS = 2000;
const HINT_AFTER_MS = 60000;   // uploads usually take seconds; see Findings: Embedding delay

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
    await waitUntilSearchable(db, uploadId);
  } finally {
    await client.close();
  }
}

// Checks every few seconds, printing progress only when the count changes. No time
// limit: embedding beyond the rate limit is queued, so large uploads can take a while.
// After a minute it prints a hint once, since a missing vector index would also leave
// it waiting at "0 of N" forever.
async function waitUntilSearchable(db, uploadId, { hintAfterMs = HINT_AFTER_MS } = {}) {
  const upload = await db.collection(config.collections.uploads).findOne({ _id: uploadId });
  console.log('Waiting until it is searchable (Ctrl+C is safe; npm run setup finishes it later)…');
  const started = Date.now();
  let hinted = false;
  let last = -1;
  for (;;) {
    const { searchableAt, searchable } = await checkReadiness(db, upload);
    if (searchableAt) {
      const seconds = Math.round((searchableAt - upload.uploadedAt) / 1000);
      console.log(`Searchable ${seconds} s after the upload started.`);
      return;
    }
    if (searchable !== last) {
      console.log(`  ${searchable} of ${upload.chunkCount} chunk(s) searchable`);
      last = searchable;
    }
    if (!hinted && Date.now() - started > hintAfterMs) {
      console.log('  Still waiting. Large uploads can take minutes; if the count never moves, '
        + 'check that the vector index exists and is queryable (npm run index-status).');
      hinted = true;
    }
    await new Promise((resolve) => setTimeout(resolve, CHECK_EVERY_MS));
  }
}

// Runs only when started as a command, not when another file loads it (e.g. a test of
// waitUntilSearchable).
if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { waitUntilSearchable };
