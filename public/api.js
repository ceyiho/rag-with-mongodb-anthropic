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
// starting with what was typed, best match first, at most 8, filtered by the ticked
// chips ({ type: ['pdf'], size: [] }). A 503 titleSearchUnavailable means the title
// index is missing.
export function searchTitles(query, filters) {
  return request(`/api/uploads/search?${withFilters({ q: query }, filters)}`);
}

// Counts for the Filter block (milestone 10): { type: { pdf: 2, ... }, size: { ... } },
// for the whole library, each row with the other row's chips applied. A 503
// facetsUnavailable means the title index is missing or doesn't index the facet fields
// yet.
export function countFacets(filters) {
  return request(`/api/uploads/facets?${withFilters({}, filters)}`);
}

// The query string, with each row's ticked chips comma-separated (type=pdf,md).
function withFilters(params, filters) {
  const search = new URLSearchParams(params);
  for (const [key, values] of Object.entries(filters)) if (values.length) search.set(key, values.join(','));
  return search;
}

// Uploads one file (multipart/form-data, field "file"). The reply comes once the file
// is saved: the new upload, with searchable false until its chunks are embedded.
export function uploadFile(file) {
  const body = new FormData();
  body.append('file', file);
  return request('/api/uploads', { method: 'POST', body });
}

// One upload. If it isn't searchable yet, the server first checks whether it has
// become so; the page asks this every few seconds after an upload.
export function getUpload(id) {
  return request(`/api/uploads/${encodeURIComponent(id)}`, { cache: 'no-store' });
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
