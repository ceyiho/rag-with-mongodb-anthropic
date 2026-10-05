// Saves an upload and its chunks, all or nothing:
// the upload is inserted as "processing", then its chunks, then it is flipped to
// "complete". If anything fails, the upload and its chunks are removed again.
// Problems the user can fix (a duplicate name, a wrong or empty file) throw an
// UploadError with a code (src/upload-error.js); anything else is a plain Error.

const path = require('path');
const config = require('./config');
const { getExtractor, extract } = require('./extractors');
const { splitSections } = require('./splitter');
const { UploadError } = require('./upload-error');

// A "processing" upload older than this is a leftover from a crashed ingest.
// A newer one is probably still being saved by another ingest.
const STALE_AFTER_MS = 10 * 60 * 1000;

const DUPLICATE_KEY = 11000;

async function ingest(db, name, buffer) {
  // The composed Unicode form, so the duplicate check treats both spellings of "é"
  // (one character, or e + accent as macOS sends it) as one name, from the command
  // line and the web page alike.
  const fileName = name.normalize('NFC');
  getExtractor(fileName);   // rejects unsupported types before touching the database
  const uploads = db.collection(config.collections.uploads);
  const chunks = db.collection(config.collections.chunks);

  if (await uploads.findOne({ fileName, status: 'complete' })) {
    throw alreadyUploaded(fileName);
  }
  await removeLeftovers(uploads, chunks, fileName);

  const { title, sections } = await extract(fileName, buffer);
  const pieces = splitSections(sections);
  if (!pieces.length) throw new UploadError('noText', `"${fileName}" contains no text.`);

  const { insertedId: uploadId } = await uploads.insertOne({
    fileName,
    title,
    fileType: path.extname(fileName).slice(1).toLowerCase(),
    status: 'processing',
    uploadedAt: new Date(),
  });

  try {
    await chunks.insertMany(pieces.map(({ section, chunkIndex, text }) => ({
      uploadId, fileName, section, chunkIndex, text,
    })));
    // Fails with a duplicate-key error if another upload of this name completed meanwhile.
    await uploads.updateOne(
      { _id: uploadId },
      { $set: { status: 'complete', chunkCount: pieces.length } },
    );
  } catch (err) {
    await removeUploads(uploads, chunks, [uploadId]);
    throw err.code === DUPLICATE_KEY ? alreadyUploaded(fileName) : err;
  }

  return { uploadId, chunkCount: pieces.length };
}

// Removes "processing" uploads of this name left behind by a crash.
// Rejects the ingest if one is recent, since another ingest may still be running.
async function removeLeftovers(uploads, chunks, fileName) {
  const leftovers = await uploads.find({ fileName, status: 'processing' }).toArray();
  const staleBefore = Date.now() - STALE_AFTER_MS;
  if (leftovers.some((upload) => upload.uploadedAt.getTime() > staleBefore)) {
    throw new UploadError('uploadInProgress', `"${fileName}" is being uploaded right now. Try again in a few minutes.`);
  }
  if (leftovers.length) {
    await removeUploads(uploads, chunks, leftovers.map((upload) => upload._id));
  }
}

async function removeUploads(uploads, chunks, uploadIds) {
  await chunks.deleteMany({ uploadId: { $in: uploadIds } });
  await uploads.deleteMany({ _id: { $in: uploadIds } });
}

function alreadyUploaded(fileName) {
  return new UploadError('duplicate', `"${fileName}" has already been uploaded.`);
}

module.exports = { ingest, removeUploads, STALE_AFTER_MS };
