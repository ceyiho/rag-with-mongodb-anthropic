# Project Plan: RAG Knowledge Base on MongoDB Atlas

## What we're building aka functional specifications
A personal knowledge base. Users upload files (text, markdown, later PDFs) and ask
questions in plain language. The app answers using only their content and cites which
upload and section each answer came from.

Purpose: a solo portfolio project that showcases MongoDB Atlas capabilities,
especially Vector Search.

Supported uploads: .txt, .md, and text-based PDFs. Reject scanned PDFs and images
with a clear message.

Upload-scoped questions: all uploads are shared and visible to everyone (no logins).
The user selects one upload or "All uploads" before asking. With one upload
selected, the search pre-filters by its uploadId, so answers come only from that upload.
With "All uploads", answers can come from any complete upload.
Grounding rules below apply either way.

Grounding: answers must come only from retrieved chunks, with citations.
If retrieval scores are below a threshold, reply "not found in your uploads" without
calling the LLM.

Uploads are one-way: no delete or edit in the app. Uploading a file whose name already
exists is rejected with a message. Test data is cleaned up manually in Atlas.

Deployment: runs on localhost or a private VM for demos. It is not exposed publicly,
so no logins or usage limits are needed.

## Terminology
- MDB doc: a document in MongoDB's document model (a record in a collection).
- Upload: a file the user uploads (a document in the everyday sense).
- Chunk: a piece of an upload, stored as one MDB doc in the `chunks` collection.
- Avoid the bare word "document"; use one of the terms above.

## Tech stack
- Runtime: Node.js (LTS)
- Backend: Express
- Database: MongoDB Atlas (free M0 cluster) via the official MongoDB Node.js driver
- Frontend: plain HTML + JavaScript (no framework for now)
- Language: plain JavaScript (no TypeScript for now)
- Embeddings: Auto-Embedding with Voyage AI on MongoDB Atlas, model `voyage-4`.
  Switching models later means re-embedding everything. Uses a one-time free
  allocation of 200 million tokens per model (not monthly), so avoid unnecessary
  re-embedding.
- Chunking: custom splitter (Markdown headings → paragraphs → sentences), sized in
  characters (≈4 characters per token). No library.
- PDF extraction: a pdf.js-based library (choose in milestone 6), giving text per page.
  Pages act as sections for citations. Pages with almost no text mean a scanned PDF,
  which is rejected.
- Answer generation: Anthropic API with built-in citations; one call per question,
  skipped when retrieval scores are below the threshold. Model: Claude Sonnet 5
  (`claude-sonnet-5`).
- Secrets: stored in a `.env` file, never committed to git

## How it works
1. Ingest: user uploads a file; the app extracts text and splits it into overlapping chunks.
2. Store: each chunk is saved in Atlas with its text and metadata
   (uploadId, file name, section). The app does not create vectors.
3. Embed: Atlas Auto-Embedding converts each chunk's text to a vector with Voyage AI,
   through the vector search index.
4. Retrieve: the question is sent to Atlas as text; Atlas embeds it with the same model,
   and Vector Search finds the closest chunks (pre-filtered by uploadId when one upload
   is selected).
5. Answer: if the best match scores below the threshold, reply "not found in your
   uploads". Otherwise the chunks and question go to the LLM, which answers with citations.

## MongoDB features to showcase
- Atlas Vector Search with Auto-Embedding, pre-filtered by upload (uploadId)
- Hybrid search: vector search combined with Atlas Search (keyword/fuzzy)
- Optional: aggregation pipeline analytics (most-asked questions, most-cited uploads,
  questions with no good match). Parked; see the last milestone.

## Milestones

### Phase 1: core
1. Connect to Atlas and verify the connection. (No AI yet.)
2. Ingest from the command line: read a .txt or .md file, find sections (Markdown
   headings; plain text is one section), split into overlapping chunks, and save the
   upload and its chunks. Reject duplicate file names and unsupported types.
   Structure: one extractor per file type returns sections ({ section, text }); one
   shared splitter chunks them, so PDF support later only adds an extractor.
   All-or-nothing: an upload has a status (processing → complete); only complete
   uploads count as duplicates, so a failed ingest can be retried.
   Create `config.js` with the collection names and chunk sizes, and create the
   regular indexes (see Decisions).
   Inspect the chunks in Atlas (no embedding tokens are spent yet).
3. Create the vector search index with Auto-Embedding, with uploadId as a filter field.
   Wait until it reports ready. Note that embedding runs in the background: measure how
   long new chunks take to become searchable, and record it under Findings (milestone 8
   uses it for the "processing… ready" state).
   Before creating the index: check the Atlas docs for which changes trigger
   re-embedding (show the user the source), and check the M0 limit on search indexes
   (this project plans a vector and a keyword index). After embedding, measure M0
   storage use (512 MB limit).
4. Search from the command line: a text question returns the top chunks with scores,
   with and without the uploadId filter. Save test questions (answerable and not, each
   with the upload it should find) in `test-questions.json`, run them, and choose the
   "not found" score threshold (record it under Findings). Milestone 9 reuses this file
   to compare hybrid search with vector-only search.
   Search only complete uploads: "All uploads" filters on
   `uploadId: { $in: [complete upload ids] }` instead of no filter, so orphan chunks
   and crash leftovers never reach an answer.
5. Answer: apply the threshold check, then the LLM answers with citations
   (upload + section). The system prompt treats uploaded text as material to answer
   from, never as instructions. Store thresholds in `config.js` (application code,
   committed, not `.env`), one per search mode, with a comment pointing to Findings.
6. PDF support (command line): add a PDF extractor for text-based PDFs; reject scanned
   PDFs with a clear message. Comes before the API and web page so they are built once
   for all file types.

### Phase 2
7. Express API: one shared database client; routes to upload, list uploads, and ask.
   Test with curl before building any UI. Name the entry file `server.js` (not
   `index.js`) and point `npm start` at it; `package.json` needs no `main` field,
   since the app is run, never imported.
8. Web page: upload form, upload picker (including "All uploads"), question box,
   answers with citations. Show a "processing… ready" state after upload, since new
   chunks are not searchable until their embeddings exist.
9. Hybrid search: add an Atlas Search (keyword) index and combine it with vector search.
   Combined scores use a different scale, so re-tune the "not found" threshold (record
   it under Findings), and
   compare against vector-only results using `test-questions.json`.
   Optional, for the demo: a search mode switch on the page (Vector · Keyword · Hybrid)
   to show how results differ, e.g. for exact codes or typos.

### Phase 3
10. README with architecture diagram, and a demo video.

### Optional (parked)
11. Analytics: log each question, top score, and cited chunks in a `questions`
    collection, then build an analytics view with aggregation pipelines.

## Open decisions
- Milestone 8: let the picker select several uploads, not just one or "All uploads"?
  The vector search filter would be `uploadId: { $in: [...] }`; the vector index stays
  the same, so no re-embedding.
- Milestone 3/8: how to record that an upload's chunks are searchable (embeddings done).
  Kept out of `status`, which is the ingest state only and drives the duplicate index.
  Options on `uploads`:
  - `searchableAt` (Date): unset until searchable. "Ready" = the field exists. It also
    records when, so `searchableAt − uploadedAt` gives the embedding delay per upload.
  - `searchable` (boolean): false → true. Simpler to read, but doesn't record when.

  It may not need storing at all if the UI uses the delay measured in milestone 3.
  Decide once we know how Atlas reports embedding progress.

## Decisions
- Database: `knowledge_base` (`DB_NAME` in `.env`).
- Schema: two collections, names in `config.js`.
  - `uploads`: `_id` (the uploadId), `fileName`, `title`, `fileType`, `status`
    (processing → complete), `uploadedAt`, `chunkCount`. `title` comes from the file
    (first `#` heading in Markdown; PDF metadata later), else from the file name.
  - `chunks`: `uploadId` (ObjectId), `fileName` (copied for citations), `section`,
    `chunkIndex`, `text` (heading path + body; the auto-embedded field).
  - Indexes: `uploads` partial unique on `fileName` where status is complete;
    `chunks` on `uploadId`. The vector index filters on `uploadId` only.
- Vector index `chunks_vector_cosine` on `chunks` (created by `npm run setup`):
  autoEmbed on `text`, model `voyage-4`, 1024 dimensions, scalar quantization, cosine
  similarity; filter on `uploadId` (queries must pass ObjectIds, not strings).
  Search indexes can't be edited: a changed definition gets a new index under a new
  name (use the spare slot), then the old one is dropped. Setup skips an index that
  already exists and never updates one.
- Chunk size: 1,600 characters, max 2,000, overlap 200, headings as hard boundaries.
  Values in `config.js`; confirm in milestone 4 before bulk uploads.

## Findings
Measured results and the values chosen from them, with a short reason. Filled in as
milestones run.
- Embedding delay (milestone 3): about 5–11 s from upload to fully searchable
  (1-chunk upload: 7–11 s; 6-chunk upload: ≤5 s, all chunks at once). It did not
  grow with chunk count at this size. Measured with `npm run probe` ("N of N found").
  Building the vector index over 17 existing chunks took about 80 s.
- Similarity (milestone 3): dotProduct with scalar quantization squeezed every score
  to about 0.50 (relevant vs off-topic differed by ~0.003). Cosine separates them
  (about 0.67–0.72 vs 0.55–0.58), with the same ranking. Chose cosine.
- Re-embedding triggers (milestone 3, Atlas docs): inserting a chunk or changing its
  `text` embeds that chunk; changing other fields or deleting does not. Changing the
  model, embedded path, dimensions or quantization rebuilds and re-embeds everything.
  An autoEmbed field can't be edited. Adding filter fields later isn't documented.
  Dropping an index also removes its stored embeddings.
- M0 limits (milestone 3): 3 search indexes (we plan 2, one spare for replacing an
  index side by side). Auto-Embedding needs no extra setup on M0.
- Storage (milestone 3): about 2.2–2.5 KB per chunk (text ≈1.0 KB, embedding ≈1.2 KB
  at 1 byte per dimension), plus index overhead. 512 MB fits well over 100,000
  chunks, so storage, not the 200M-token allowance (~500,000 chunks), is the tighter
  limit. Whole cluster at 24 chunks: ≈424 KB.
- "Not found" score threshold (milestone 4): not chosen yet
- Hybrid "not found" score threshold (milestone 9): not chosen yet

## Current status
- Git installed; Atlas account set up. Milestone 1 is completed.
- Milestone 2 is completed: `npm run ingest -- <file>` saves .txt and .md uploads and
  their chunks. Two samples are in Atlas (nimbus-guide.md: 11 chunks,
  nimbus-admin-handbook.txt: 6 chunks). Next: milestone 3 (vector index).
- Commands: `npm run setup` (indexes), `npm run chunk -- <file>` (preview, no database),
  `npm run ingest -- <file>`, `npm run cleanup` (see cleanup.js), `npm run check-db` (connection check).
