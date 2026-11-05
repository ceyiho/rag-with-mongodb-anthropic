// An upload the user can fix: a wrong file type, a duplicate name, a scanned PDF.
// Thrown by src/ingest.js and the extractors, as opposed to a bug or an outage (a plain
// Error). Each carries a code from docs/API_SPEC.md (POST /api/uploads), so the API can
// answer with the right 4xx; the command line just prints the message.

class UploadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UploadError';
    this.code = code;
  }
}

module.exports = { UploadError };
