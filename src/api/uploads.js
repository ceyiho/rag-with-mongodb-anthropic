// Upload routes (see API_SPEC.md: Uploads). Only complete uploads are returned;
// "processing" is the ingest's internal state and never reaches the page.
//   GET /api/uploads       all complete uploads, sorted by title
//   GET /api/uploads/:id   one upload, after the readiness check if it isn't searchable

const express = require('express');
const config = require('../config');
const { checkReadiness } = require('../readiness');
const { ApiError } = require('./errors');
const { toObjectId } = require('./ids');

// The shape every upload route returns. searchable comes from searchableAt (set once
// all the upload's chunks are searchable), never from status.
function toUpload(upload) {
  return {
    id: upload._id.toHexString(),
    title: upload.title,
    fileName: upload.fileName,
    fileType: upload.fileType,
    chunkCount: upload.chunkCount,
    uploadedAt: upload.uploadedAt,
    searchable: Boolean(upload.searchableAt),
  };
}

module.exports = function uploadsRoutes(db) {
  const router = express.Router();
  const uploads = db.collection(config.collections.uploads);

  // Reports what is stored and never runs the readiness check, so it stays cheap.
  // The collation sorts as a person would: "apple" next to "Apple", not after "Zebra".
  router.get('/uploads', async (req, res) => {
    const found = await uploads
      .find({ status: 'complete' })
      .sort({ title: 1 })
      .collation({ locale: 'en' })
      .toArray();
    res.json(found.map(toUpload));
  });

  // The page asks this every few seconds after an upload, until searchable is true.
  // Once searchableAt is set, it is never checked again, so later calls are one read.
  // no-store: the browser must never answer a check from its cache.
  // Fixed paths like /uploads/search must be defined above this one, or ":id" would
  // catch them.
  router.get('/uploads/:id', async (req, res) => {
    const _id = toObjectId(req.params.id);
    const upload = await uploads.findOne({ _id, status: 'complete' });
    if (!upload) {
      throw new ApiError(404, 'uploadNotFound', 'This upload doesn\'t exist (or is still being saved).');
    }
    if (!upload.searchableAt) {
      upload.searchableAt = (await checkReadiness(db, upload)).searchableAt;
    }
    res.set('Cache-Control', 'no-store').json(toUpload(upload));
  });

  return router;
};
