// Upload routes (see API_SPEC.md: Uploads). Only complete uploads are returned;
// "processing" is the ingest's internal state and never reaches the page.
//   GET /api/uploads       all complete uploads, sorted by title
//   GET /api/uploads/search?q=   title search for the picker (Atlas Search autocomplete)
//   GET /api/uploads/:id   one upload, after the readiness check if it isn't searchable
//   POST /api/uploads      saves an uploaded file (multipart/form-data, field "file")

const express = require('express');
const multer = require('multer');
const config = require('../config');
const { ingest } = require('../ingest');
const { checkReadiness } = require('../readiness');
const { searchTitles } = require('../title-search');
const { UploadError } = require('../upload-error');
const { ApiError } = require('./errors');
const { toObjectId } = require('./ids');

// HTTP status for each UploadError code thrown by src/ingest.js and the extractors.
const UPLOAD_ERROR_STATUS = {
  unsupportedType: 415,
  duplicate: 409,
  uploadInProgress: 409,
  scannedPdf: 422,
  unreadablePdf: 422,
  noText: 422,
};

// multer reads the multipart body. Memory storage: the file is never written to disk,
// and req.file.buffer holds its bytes. defParamCharset: browsers send file names as
// UTF-8, but multer reads them as Latin-1 by default, which garbles "café.pdf".
const readFile = multer({
  storage: multer.memoryStorage(),
  defParamCharset: 'utf8',
  limits: { fileSize: config.upload.maxMegabytes * 1024 * 1024, files: 1, fields: 10 },
}).single('file');

// Runs multer and turns its errors into API errors: they are all about the request
// (too large, a second file, a broken body), so a 4xx rather than a 500.
function readUpload(req, res) {
  return new Promise((resolve, reject) => {
    readFile(req, res, (err) => {
      if (!err) return resolve(req.file);
      if (err.code === 'LIMIT_FILE_SIZE') {
        return reject(new ApiError(413, 'fileTooLarge', `Files can be up to ${config.upload.maxMegabytes} MB.`));
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') {
        return reject(new ApiError(400, 'unexpectedFile', 'Send one file, in the field "file".'));
      }
      return reject(new ApiError(400, 'invalidUpload', `The upload couldn't be read (${err.message}).`));
    });
  });
}

// The file name as the user sees it: the last part only, in case a browser sends a
// folder path. Put in the composed Unicode form here only so its length is counted as
// stored; src/ingest.js normalises it for the duplicate check.
function cleanFileName(name) {
  const fileName = name.split(/[\\/]/).pop().normalize('NFC').trim();
  if ([...fileName].length > config.upload.maxFileNameLength) {
    throw new ApiError(400, 'fileNameTooLong',
      `File names can be up to ${config.upload.maxFileNameLength} characters.`);
  }
  return fileName;
}

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

  // The picker's title search, asked once typing pauses. An empty q gives []. If the
  // title index is missing (e.g. dropped while being changed), the page filters its
  // own list instead.
  router.get('/uploads/search', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
    const found = await searchTitles(db, q);
    if (!found) {
      throw new ApiError(503, 'titleSearchUnavailable', 'Title search is unavailable right now.');
    }
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

  // Saves the file with the same ingest as npm run ingest (all or nothing), and replies
  // once it is saved: 201 with searchable false. Unlike npm run ingest, it doesn't wait
  // for searchable; the page checks GET /api/uploads/:id instead. If the user leaves
  // the page meanwhile, the ingest still finishes.
  router.post('/uploads', async (req, res) => {
    const file = await readUpload(req, res);
    if (!file) throw new ApiError(400, 'noFile', 'Choose a file to upload.');
    const fileName = cleanFileName(file.originalname);

    let uploadId;
    try {
      ({ uploadId } = await ingest(db, fileName, file.buffer));
    } catch (err) {
      if (err instanceof UploadError) throw new ApiError(UPLOAD_ERROR_STATUS[err.code] ?? 400, err.code, err.message);
      throw err;
    }
    res.status(201).json(toUpload(await uploads.findOne({ _id: uploadId })));
  });

  return router;
};
