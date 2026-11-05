// API errors. Every error reply is an HTTP status plus
// { "error": { "code": "...", "message": "..." } } (see docs/API_SPEC.md: Conventions).
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
  const known = err instanceof ApiError ? err : fromBodyParser(err);
  if (known) {
    res.status(known.status).json({ error: { code: known.code, message: known.message } });
    return;
  }
  console.error(`${req.method} ${req.originalUrl} failed:`, err);
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong.' } });
}

// express.json() rejects a body it can't read before any route runs; its errors carry
// a `type`. Those are the client's mistake, so a 4xx rather than a 500.
function fromBodyParser(err) {
  if (err.type === 'entity.parse.failed') {
    return new ApiError(400, 'invalidJson', 'The request body isn\'t valid JSON.');
  }
  if (err.type === 'entity.too.large') {
    return new ApiError(413, 'requestTooLarge', 'The request body is too large.');
  }
  return null;
}

module.exports = { ApiError, routeNotFound, handleErrors };
