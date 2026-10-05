// Upload routes (see API_SPEC.md: Uploads). Only complete uploads are returned;
// "processing" is the ingest's internal state and never reaches the page.
//   GET /api/uploads   all complete uploads, sorted by title

const express = require('express');
const config = require('../config');

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

  return router;
};
