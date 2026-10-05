# API spec

The Express API (milestone 7) and how the web page (milestone 8) uses it: routes,
request and response formats, error codes, and the `src/` changes milestone 7 needs.
Written before milestone 7 from the wireframe (`wireframe/index.html`, whose state
menu names the route behind each state). Decisions and reasons are in PROJECT_PLAN.md;
this file is the detail. Update it when a route changes.

## Conventions

- JSON in and out, except the upload (`multipart/form-data`).
- Ids are an upload's `_id` as a 24-character hex string. The server converts them to
  ObjectIds (the vector index filter needs ObjectIds); a malformed id is a 400.
- Errors: an HTTP status plus `{ "error": { "code": "...", "message": "..." } }`. The
  message is written for the user. The page picks its wording by `code`, and shows
  `message` for a code it has no wording for. A 500 says only "Something went wrong";
  the details go to the server log. An unknown `/api` route is a 404 `routeNotFound`.
- "Not found in your uploads" is a normal answer (200), not an error.
- A failed `fetch()` (no HTTP status at all) means the server is unreachable; the page
  handles it apart from API errors, and tells it apart from an unreachable database
  with `GET /api/health`.
- The server listens on `127.0.0.1:3000` by default; `HOST` and `PORT` in `.env`
  change it (e.g. for the VM). It serves the page from `public/` at `/`, so page and API share an
  address and the browser needs no cross-site (CORS) permission.

## Server

### `GET /api/health`

Whether the server can reach the database (a `ping` to Atlas).

- `200` `{ "db": "ok" }`
- `503` `dbUnavailable`

The page calls it on load and whenever a request fails, and drives the header's
connection dot from it. Its banner then says which part is down:
- `fetch()` fails: "Can't reach the server. Is it running (`npm start`)?"
- `503`: "The server can't reach the database. Check Atlas Network Access; your IP
  address may have changed."

## Uploads

Every route returns uploads in this shape:

```json
{
  "id": "66f1c0ffee0000000000abcd",
  "title": "Nimbus Admin Handbook",
  "fileName": "nimbus-admin-handbook.txt",
  "fileType": "txt",
  "chunkCount": 7,
  "uploadedAt": "2026-10-02T09:14:03.120Z",
  "searchable": true
}
```

- Only complete uploads are returned. `status: 'processing'` is the ingest's internal
  state and never reaches the page.
- `searchable` comes from `searchableAt` (set once the upload's chunks are all
  searchable). The page's "processing… → ready" label comes from `searchable`, never
  from `status`.

### `GET /api/uploads`

All complete uploads, sorted by title (case-insensitive). Reports what is stored; it
never runs the readiness check, so it stays cheap however many uploads are processing.

`200` `[upload, ...]`

Uploads are shared, and the command line can add them too, so the page reloads the
list when its browser tab regains focus, and after a question fails with
`uploadNotFound` or `uploadNotReady` (a ticked upload that is gone is unticked, with a
notice).

### `GET /api/uploads/search?q=<text>`

Title search for the picker: Atlas Search autocomplete on `title` and `fileName`, with
fuzzy matching (a typo like "nimbsu" finds Nimbus), complete uploads only, at most 8.

- `200` `[upload, ...]`; an empty `q` gives `[]`.
- `503` `titleSearchUnavailable`: the title index is missing (e.g. dropped while being
  changed). The page then filters its own list in the browser.

To settle in milestone 7, with the real titles: how autocomplete splits file names
with hyphens (`nimbus-admin-handbook.txt`), and how many characters are typed before
suggestions appear. The page sends a request once typing pauses for about 200 ms,
not on every key.

### `GET /api/uploads/:id`

One upload. If its `searchableAt` is unset, the server first runs the readiness check
(`src/readiness.js`): an exact vector search filtered to the upload, `limit` =
`chunkCount`, then a count. When the count reaches `chunkCount`, it sets `searchableAt`,
only if still unset, so two tabs checking at once is harmless. Once set, it is never
checked again.

- `200` `upload`, sent with `Cache-Control: no-store` so the browser never answers a
  check from its cache
- `400` `invalidId`
- `404` `uploadNotFound`

The page checks each upload whose `searchable` is false every 3 s for the first minute,
then every 15 s, with no give-up (embedding beyond the rate limit is queued, so large
uploads can take a while). After a reload, it resumes for any listed upload that isn't
searchable.

Who sets `searchableAt`. Every path runs the same check from `src/readiness.js`:
- Uploads from the page: the page's checks above.
- `npm run ingest`: after saving, it waits until the upload is searchable, sets
  `searchableAt`, and prints how long it took (no need for `npm run probe`).
- `npm run setup`: sets it for any complete upload that lacks it. The first run fills
  in the uploads saved before `searchableAt` existed (their delay, `searchableAt −
  uploadedAt`, is meaningless); later runs catch an upload whose ingest or page was
  closed before it was ready.

Until it is set, an upload is left out of "All uploads" and can't be ticked.

### `POST /api/uploads`

`multipart/form-data` with one field, `file`. Read by `multer` into memory; the file
is never written to disk. Its file name:
- arrives decoded as Latin-1, so non-ASCII names ("café.pdf") are converted back to
  UTF-8;
- is cut to its last part, in case a browser sends a folder path;
- is limited to 255 characters (`400` `fileNameTooLong`).

The request stays open until the ingest has finished (all or nothing, as on the
command line).

`201` `upload` (complete, `searchable: false`)

| Status | Code | When |
|---|---|---|
| 400 | `noFile` | No `file` field. |
| 400 | `fileNameTooLong` | A file name over 255 characters. |
| 413 | `fileTooLarge` | Over 50 MB. |
| 415 | `unsupportedType` | Not `.txt`, `.md` or `.pdf`. |
| 409 | `duplicate` | A complete upload with this file name exists. |
| 409 | `uploadInProgress` | An ingest of this file name started under 10 minutes ago. |
| 422 | `scannedPdf` | The PDF has almost no text (scanned). Nothing is saved. |
| 422 | `unreadablePdf` | The PDF can't be parsed. |
| 422 | `noText` | No text after extraction. |

The page:
- Uploads one file at a time: while one runs, the button reads "Uploading…" and is
  greyed out, and a file dropped meanwhile is refused with a notice (not queued).
  This holds per page only: two open browsers can still upload at once, which the
  server handles (each request is separate, and the same name is blocked).
- Asks before the page is left or reloaded mid-upload (`beforeunload`). If the user
  leaves anyway, the server still finishes the ingest; only the progress card is lost.
- May warn about a duplicate name before sending, since it has the list; the server's
  check is the real one.

## Questions

### `POST /api/ask`

```json
{ "question": "How long is an invitation valid?", "uploadIds": ["66f1...", "66f2..."] }
{ "question": "How long is an invitation valid?", "scope": "all" }
```

- Exactly one of `uploadIds` (one or more) or `scope: "all"`. Neither is a 400, so a
  bug that sends an empty list can't quietly search everything.
- `uploadIds`: each must be a searchable upload. Exact search with
  `uploadId: { $in: [...] }`; the threshold for selected uploads. If the ticked
  uploads hold more than 10,000 chunks in total, approximate search instead (the Atlas
  documentation recommends exact search below 10,000 MDB docs); at this project's size
  that never happens.
- `scope: "all"`: approximate search over every searchable upload (`searchableAt` set);
  the "All uploads" threshold. It includes uploads added later.
- Stateless: no conversation history. Each question is answered on its own.

`200`, an answer:

```json
{
  "found": true,
  "reason": "answered",
  "parts": [
    { "text": "Owners and administrators can invite members.", "cites": [1] },
    { "text": "An invitation stays valid for 14 days.", "cites": [2] }
  ],
  "citations": [
    {
      "n": 1,
      "uploadId": "66f1...",
      "title": "Nimbus Admin Handbook",
      "fileName": "nimbus-admin-handbook.txt",
      "fileType": "txt",
      "section": null,
      "page": null,
      "chunkIndex": 0,
      "chunkCount": 7,
      "excerpt": "Every workspace has at least one owner. …"
    }
  ],
  "retrieval": {
    "mode": "exact",
    "uploadCount": 2,
    "chunksSearched": 18,
    "threshold": 0.62,
    "topScore": 0.81,
    "llmCalled": true,
    "hits": [
      { "score": 0.81, "uploadId": "66f1...", "title": "Nimbus Admin Handbook",
        "fileType": "txt", "section": null, "page": null, "chunkIndex": 1,
        "chunkCount": 7, "cited": 2 }
    ]
  }
}
```

- `parts`: the answer split where the LLM's citations fall; `cites` are citation
  numbers. The page puts a marker after each part, so it never parses `[1]` out of
  text (a literal "[1]" in an upload can't confuse it).
- Formatting: the LLM writes simple Markdown, and a list can be cut across several
  parts. So the page joins the parts into one text with a placeholder where each
  marker goes, escapes everything, then turns a small set of Markdown into formatting
  (paragraphs, bullet and numbered lists, `code`, **bold**), and finally turns the
  placeholders into marker buttons. Anything else shows as plain text.
- Where the citation fields come from: `title`, `fileType` and `chunkCount` from
  `uploads`, joined to the search results with a `$lookup` stage after
  `$vectorSearch`; `section` and `chunkIndex` from the chunk.
- Where a citation points, by file type, and how the page shows it:
  - PDF: `page`, read from the section ("page 12"), shown as "PDF p. 12". It's the
    PDF's page number, not the printed one. No chapter, even when the chunk's prefix
    line names one.
  - Markdown: `section`, the heading path without the title, shown as
    "Installation › Windows". Text before the first heading (stored with the file
    name as its section) has `section: null` and shows no location.
  - Plain text: `section` is null, so it's shown as "passage 2 of 7" (`chunkIndex`
    + 1 of `chunkCount`).

- `excerpt`: the cited chunk's text without its prefix line, i.e. up to the first
  blank line (a built-in citation quotes the whole chunk).
- `retrieval`: for the "How this was found" panel, shown on every answer, collapsed.
  `hits` are the chunks sent to the LLM (or that would have been), best first; `cited`
  is the citation number or null. Each hit has the same location fields as a citation,
  so the page labels it the same way. No chunk text, so it stays small. Milestone 9's
  optional search mode switch would add `mode` values here.

`200`, "not found in your uploads":

```json
{
  "found": false,
  "reason": "belowThreshold",
  "parts": [],
  "citations": [],
  "retrieval": { "llmCalled": false, "...": "..." }
}
```

`reason` is `belowThreshold` (LLM not called) or `noCitations` (the LLM found no answer
in the chunks). The page shows the same message for both; the reason only shows in
"How this was found". On a not-found answer for selected uploads, the page offers "Ask
all uploads instead".

| Status | Code | When |
|---|---|---|
| 400 | `missingQuestion` | Empty after trimming. |
| 400 | `questionTooLong` | Over 1,000 characters. |
| 400 | `missingScope` | Neither `uploadIds` nor `scope: "all"`. |
| 400 | `invalidId` | A malformed id. |
| 404 | `uploadNotFound` | An id that isn't a complete upload. |
| 409 | `uploadNotReady` | An upload that isn't searchable yet. |
| 503 | `llmUnavailable` | The Anthropic API is overloaded or rate-limited. |
| 500 | `internal` | Anything else, including an LLM reply that was cut off. |

The page:
- Greys out the question box while nothing is ticked: no request is sent. A click on
  it highlights the picker.
- Disables Ask while waiting, so a double click can't cost two LLM calls.
- Keeps the question in the box after an error, for Retry.
- Escapes all text before showing it (see Formatting above): uploaded text and LLM
  output are untrusted.

## Page state that never reaches the server

- Ticks: in page memory only. They last while the page stays open; every page load
  starts with nothing ticked. Nothing is saved in the browser.
- Earlier questions: saved in the browser's `localStorage` (key `kb.history`), so they
  survive closing and reopening the page. Kept per browser and per address (localhost
  and the VM keep separate lists). Never sent to the server, and never sent to the
  LLM: each question is still answered on its own.
  - Saved: each finished answer as the API returned it (`parts`, `citations`,
    `retrieval`), with the question, the ticked uploads' ids and titles at the time,
    and when it was asked. Failed questions aren't saved.
  - A saved answer is a snapshot: it still shows if an upload it cites is removed
    later, since its titles and excerpts are stored with it.
  - The newest 50 are kept and older ones dropped (`localStorage` holds about 5 MB per
    address; an answer takes a few KB).
  - Stored with a format version. A page that finds another version starts an empty
    list rather than misreading it.
  - The section is labelled "Earlier questions" (not "in this session") and has a
    "Clear" link, since anyone using that browser sees the list.
  - If storage is blocked (e.g. a private window), the list just isn't kept.

## `src/` changes for milestone 7

1. Error codes: `src/ingest.js` and the extractors throw errors that carry a `code`
   (the codes above), so the API can tell a user mistake (4xx) from a server fault
   (500). Today both are a plain `Error`.
2. `src/search.js`: `uploadIds` (an array) instead of `uploadId`; "All uploads"
   filters on `searchableAt` instead of `status: 'complete'`; approximate search for
   ticked uploads over 10,000 chunks.
3. `src/answer.js`: the threshold by mode (selected uploads or all); returns `parts`,
   the citation fields above (`title`, `fileType` and `chunkCount` joined from
   `uploads` with `$lookup` in `src/search.js`, `page`, `excerpt`) and `retrieval`.
   Keeps `text` for `scripts/ask.js`. No data change: every field comes from what is
   stored.
4. `src/readiness.js`: the search-and-count check, moved from `tools/probe.js`, which
   then calls it. Also used by `scripts/ingest-file.js` (wait until searchable) and
   `scripts/setup-db.js` (fill in uploads that lack `searchableAt`). Must land
   together with change 2, or "All uploads" would find nothing.
5. `src/indexes.js`: the index definitions, moved from `scripts/setup-db.js`, plus the
   title index (`uploads_title_autocomplete`). At startup the server stops if the vector
   index is missing and only warns if the title index is.
6. `src/config.js`: the title index name, the upload size limit, and the threshold
   names (`oneUpload` becomes the threshold for selected uploads).
7. `scripts/ask.js`: `--upload` may be given more than once.
8. Tests: a few questions in `test/questions.json` that use 2–3 ticked uploads, with
   support in `tools/run-test-questions.js` and `tools/run-test-answers.js`, to check
   the threshold for selected uploads.

New in milestone 7: `server.js` at the root (`npm start`), its routes in `src/api/`
(including `GET /api/health`), and the dependencies `express` 5 and `multer` 2.
Milestone 8 adds the page in `public/`.

## Why it's built this way

The reasons behind PROJECT_PLAN.md's "Web page and API" decisions, settled during the
wireframe review (2026-10-02).

- Picker: nothing ticked when the page opens, so asking is a deliberate choice. Not
  chosen: "All uploads" as the default. Ticks aren't kept across reloads, since the
  next visit may be about different uploads. Not chosen: remembering them in the
  browser (`localStorage`), first agreed, then dropped after trying it in the
  wireframe.
- Readiness: search and count checks "searchable", the real end result, using public
  features only. Not chosen: counting the generated embeddings (one step short of
  searchable, and their collection is found by a generated name whose format has
  changed before), or a fixed wait (no guarantee for large uploads). Ids rather than
  file names in the route: the page already has the ids, and they need no encoding in
  an address. Setup and the ingest command set `searchableAt` too, because "All
  uploads" only searches uploads that have it: without them, existing and
  command-line uploads would drop out, and the tests with them. Not chosen: the
  server checking unready uploads itself on each "All uploads" question (no gaps,
  but not needed for a demo).
- Health check: an unreachable database (e.g. after an IP change, which Atlas Network
  Access refuses) would otherwise look like every request failing with a vague 500.
- Answer formatting: a small Markdown subset keeps lists and code readable while
  everything else stays escaped. Not chosen: asking the LLM for plain text (a prompt
  change, which would need a full answer test run).
- List refresh on tab focus: uploads are shared and can come from the command line.
  Not chosen: refreshing on a timer.
- Uploads wait for the ingest: it is already all or nothing, the 280-page book took
  seconds, and Node waits up to 5 minutes by default. A background job is only worth
  building if a real upload gets close to that. One at a time keeps the page simple
  and stops two large PDFs racing for embedding. Not chosen: queueing a second file.
- PDF citations give the page only (2026-10-05): the page number says clearly where a
  citation comes from, and the API stays simple. The chapter is only in the chunk's
  prefix line, and neither real PDF has chapter names. Not chosen: reading it from
  that line, or storing a `chapter` field (a schema change and a backfill).
- Answers as parts: the page never parses markers out of text. "How this was found"
  is shown to everyone, collapsed: it is the visible Vector Search showcase, and there
  are no logins or public access to protect. Not chosen: a debug-only mode.
- Earlier questions in `localStorage` (2026-10-03): wanted after closing and reopening
  the page. Not chosen: `sessionStorage` (lost when the tab closes), or a `questions`
  collection in Atlas (a server change; the parked analytics milestone may log
  questions there anyway).
- Standalone questions: follow-ups would need an extra LLM call to rewrite a question
  like "what about macOS?" before searching, would resend earlier answers, and would
  let earlier answers leak into a reply its citations don't support. Out of scope for
  a demo.
- `127.0.0.1`: Express otherwise listens on every network the computer is on, so
  anyone on the same Wi-Fi could upload files and spend LLM calls.
