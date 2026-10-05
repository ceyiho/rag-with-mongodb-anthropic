// API errors. Every error reply is an HTTP status plus
// { "error": { "code": "...", "message": "..." } } (see API_SPEC.md: Conventions).
// A route throws an ApiError for a known case; anything else is a 500 that says only
// "Something went wrong", with the details in the server log.
// Express 5 passes errors thrown in async routes on to handleErrors by itself, so
// routes need no try/catch of their own.

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Mounted after the routes under /api: a request that reaches it matched none.
function routeNotFound(req, res) {
  throw new ApiError(404, 'routeNotFound', `No API route for ${req.method} ${req.originalUrl}.`);
}

// Error-handling middleware: Express recognises it by its four parameters, so `next`
// stays even though it's unused.
function handleErrors(err, req, res, next) {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  console.error(`${req.method} ${req.originalUrl} failed:`, err);
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong.' } });
}

module.exports = { ApiError, routeNotFound, handleErrors };
