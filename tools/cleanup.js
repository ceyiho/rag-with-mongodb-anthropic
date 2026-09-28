// Maintenance: removes data the app does not clean up by itself.
// Without --yes it only lists what it would remove, so you can check first.
//
//   npm run cleanup
//     Lists orphan chunks and stale "processing" uploads (any file name).
//   npm run cleanup -- --yes
//     Removes them. Never touches "complete" uploads or recent "processing" ones.
//   npm run cleanup -- <fileName>
//     Lists one upload (any status, including "complete") and its chunks.
//   npm run cleanup -- <fileName> --yes
//     Removes that upload and its chunks. The only way to remove a complete upload
//     from code; use it instead of deleting in Atlas by hand, which leaves orphans.
//
// The "--" tells npm that what follows is for this script, not for npm itself.
//
// What gets cleaned up:
// - Stale "processing" upload: an ingest that started but never finished (the process
//   died). Older than STALE_AFTER_MS (10 minutes); a newer one may still be running,
//   so it is left alone.
// - Orphan chunk: a chunk whose upload no longer exists, e.g. after deleting an
//   upload by hand in Atlas.
// Both would otherwise show up in "All uploads" searches.

const { connect } = require('../src/db');
const config = require('../src/config');
const { removeUploads, STALE_AFTER_MS } = require('../src/ingest');

async function main() {
  // process.argv holds the command line: [node, script, ...arguments].
  const args = process.argv.slice(2);
  const confirmed = args.includes('--yes');
  const fileName = args.find((arg) => !arg.startsWith('--'));   // first non-flag argument

  const { client, db } = await connect();
  try {
    const uploads = db.collection(config.collections.uploads);
    const chunks = db.collection(config.collections.chunks);

    // 1. Find what to remove. With a file name: every upload of that name.
    //    Without: stale "processing" uploads, plus orphan chunks.
    const targetUploads = fileName
      ? await uploads.find({ fileName }).toArray()
      : await uploads.find({
        status: 'processing',
        uploadedAt: { $lt: new Date(Date.now() - STALE_AFTER_MS) },   // older than the cut-off
      }).toArray();
    const orphans = fileName ? [] : await findOrphans(chunks, uploads.collectionName);

    if (!targetUploads.length && !orphans.length) {
      console.log(fileName ? `No upload named "${fileName}".` : 'Nothing to clean up.');
      return;
    }

    // 2. List it.
    for (const upload of targetUploads) {
      const count = await chunks.countDocuments({ uploadId: upload._id });
      console.log(`Upload "${upload.fileName}" (${upload.status}, ${upload.uploadedAt.toISOString()}): ${count} chunk(s)`);
    }
    for (const orphan of orphans) {
      console.log(`Orphan chunks of missing upload ${orphan._id} ("${orphan.fileName}"): ${orphan.count}`);
    }

    // 3. Stop here unless --yes was given (a "dry run").
    if (!confirmed) {
      console.log('\nNothing removed. Run again with --yes to remove the above.');
      return;
    }

    // 4. Remove it. removeUploads is shared with ingest: it deletes the chunks first,
    //    then the uploads, so an interruption never leaves orphan chunks behind.
    await removeUploads(uploads, chunks, targetUploads.map((upload) => upload._id));
    await chunks.deleteMany({ uploadId: { $in: orphans.map((orphan) => orphan._id) } });
    console.log('\nRemoved.');
  } finally {
    await client.close();
  }
}

// Finds chunks whose upload no longer exists, with an aggregation pipeline
// (each stage works on the output of the one before):
function findOrphans(chunks, uploadsCollectionName) {
  return chunks.aggregate([
    // One result per uploadId found in chunks, with a file name and a chunk count.
    { $group: { _id: '$uploadId', fileName: { $first: '$fileName' }, count: { $sum: 1 } } },
    // Join each result to its upload (MongoDB's join); "upload" becomes an array of matches.
    { $lookup: { from: uploadsCollectionName, localField: '_id', foreignField: '_id', as: 'upload' } },
    // Keep only the results whose upload was not found: those chunks are orphans.
    { $match: { upload: { $size: 0 } } },
  ]).toArray();
}

main().catch((err) => {
  console.error('Cleanup failed:', err.message);
  process.exit(1);
});
