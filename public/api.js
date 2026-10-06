// Talks to the API server (routes and formats in API_SPEC.md). Each call returns the
// reply's JSON, or throws one of two errors:
// - ServerUnreachable: fetch() itself failed, so there was no HTTP reply at all (the
//   server is stopped, or the network is down).
// - ApiError: the server replied with an error, { error: { code, message } }. The page
//   picks its wording by code, and shows the message for a code it has no wording for.

export class ServerUnreachable extends Error {}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(path, options) {
  let res;
  try {
    res = await fetch(path, options);
  } catch {
    throw new ServerUnreachable("Can't reach the server.");
  }
  // A reply that isn't JSON (e.g. an error page from something in between) counts as
  // a server fault.
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, body?.error?.code ?? 'internal', body?.error?.message ?? 'Something went wrong.');
  }
  return body;
}

// All complete uploads, sorted by title.
export function listUploads() {
  return request('/api/uploads');
}

// Title search for the picker: complete uploads whose title or file name has words
// starting with what was typed, best match first, at most 8. A 503
// titleSearchUnavailable means the title index is missing.
export function searchTitles(query) {
  return request(`/api/uploads/search?q=${encodeURIComponent(query)}`);
}

// Answers a question from the given uploads (ids), or from all uploads when uploadIds
// is null. "Not found in your uploads" is a normal reply (found: false), not an error.
export function askQuestion(question, uploadIds) {
  return request('/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(uploadIds ? { question, uploadIds } : { question, scope: 'all' }),
  });
}

// Which part is reachable: 'ok', 'database' when the server replies but can't reach
// the database (503), or 'server' when there is no usable reply.
export async function checkHealth() {
  try {
    await request('/api/health', { cache: 'no-store' });
    return 'ok';
  } catch (err) {
    return err instanceof ApiError && err.code === 'dbUnavailable' ? 'database' : 'server';
  }
}
