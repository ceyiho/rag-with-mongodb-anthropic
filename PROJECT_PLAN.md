# Project Plan: RAG Knowledge Base on MongoDB Atlas

## What we're building aka functional specifications
A personal knowledge base. Users upload documents (text, markdown, later PDFs) and ask
questions in plain language. The app answers using only their content and cites which
document and section each answer came from.

Purpose: a solo portfolio project that showcases MongoDB Atlas capabilities,
especially Vector Search.

Supported uploads: .txt, .md, and text-based PDFs. Reject scanned PDFs and images
with a clear message.

Document-scoped questions: all uploads are shared and visible to everyone (no logins).
The user selects one document or "All documents" before asking. With one document
selected, the search pre-filters by its uploadId, so answers come only from that document.
With "All documents", no filter is applied and answers can come from any upload.
Grounding rules below apply either way.

Grounding: answers must come only from retrieved chunks, with citations.
If retrieval scores are below a threshold, reply "not found in your documents" without
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
   and Vector Search finds the closest chunks (pre-filtered by uploadId when one document
   is selected).
5. Answer: if the best match scores below the threshold, reply "not found in your
   documents". Otherwise the chunks and question go to the LLM, which answers with citations.

## MongoDB features to showcase
- Atlas Vector Search with Auto-Embedding, pre-filtered by document (uploadId)
- Hybrid search: vector search combined with Atlas Search (keyword/fuzzy)
- Optional: aggregation pipeline analytics (most-asked questions, most-cited documents,
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
4. Search from the command line: a text question returns the top chunks with scores,
   with and without the uploadId filter. Save test questions (answerable and not, each
   with the document it should find) in `test-questions.json`, run them, and choose the
   "not found" score threshold (record it under Findings). Milestone 9 reuses this file
   to compare hybrid search with vector-only search.
5. Answer: apply the threshold check, then the LLM answers with citations
   (document + section). The system prompt treats document text as material to answer
   from, never as instructions. Store thresholds in `config.js` (application code,
   committed, not `.env`), one per search mode, with a comment pointing to Findings.
6. PDF support (command line): add a PDF extractor for text-based PDFs; reject scanned
   PDFs with a clear message. Comes before the API and web page so they are built once
   for all file types.

### Phase 2
7. Express API: one shared database client; routes to upload, list documents, and ask.
   Test with curl before building any UI.
8. Web page: upload form, document picker (including "All documents"), question box,
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
- Milestone 8: let the picker select several uploads, not just one or "All documents"?
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
- Chunk size: 1,600 characters, max 2,000, overlap 200, headings as hard boundaries.
  Values in `config.js`; confirm in milestone 4 before bulk uploads.

## Findings
Measured results and the values chosen from them, with a short reason. Filled in as
milestones run.
- Embedding delay (milestone 3): not measured yet
- "Not found" score threshold (milestone 4): not chosen yet
- Hybrid "not found" score threshold (milestone 9): not chosen yet

## Current status
- Git installed; Atlas account set up. Milestone 1 is completed.
- Milestone 2 is completed: `npm run ingest -- <file>` saves .txt and .md uploads and
  their chunks. Two samples are in Atlas (nimbus-guide.md: 11 chunks,
  nimbus-admin-handbook.txt: 6 chunks). Next: milestone 3 (vector index).
