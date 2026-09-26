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

## Tech stack
- Runtime: Node.js (LTS)
- Backend: Express
- Database: MongoDB Atlas (free M0 cluster) via the official MongoDB Node.js driver
- Frontend: plain HTML + JavaScript (no framework for now)
- Language: plain JavaScript (no TypeScript for now)
- Embeddings: Auto-Embedding with Voyage AI on MongoDB Atlas. Uses a one-time free
  allocation of 200 million tokens per model (not monthly), so avoid unnecessary
  re-embedding.
- Answer generation: Anthropic API
- Secrets: stored in a `.env` file, never committed to git

## How it works
1. Ingest: user uploads a file; the app extracts text and splits it into overlapping chunks.
2. Store: each chunk is saved in Atlas with its text and metadata
   (uploadId, source file, section, upload date). The app does not create vectors.
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
- Flexible document model: text, vector, and metadata in one document
- Optional: aggregation pipeline analytics (most-asked questions, most-cited documents,
  questions with no good match). Parked; see the last milestone.

## Milestones

### Phase 1: core
1. Connect to Atlas and verify the connection. (No AI yet.)
2. Ingest from the command line: read a .txt or .md file, find sections (Markdown
   headings; plain text is one section), split into overlapping chunks, and save the
   upload and its chunks. Reject duplicate file names and unsupported types.
   Inspect the chunks in Atlas (no embedding tokens are spent yet).
3. Create the vector search index with Auto-Embedding, with uploadId as a filter field.
   Wait until it reports ready.
4. Search from the command line: a text question returns the top chunks with scores,
   with and without the uploadId filter. Run a few test questions (answerable and not)
   and choose the "not found" score threshold.
5. Answer: apply the threshold check, then the LLM answers with citations
   (document + section).
6. Express API: one shared database client; routes to upload, list documents, and ask.
   Test with curl before building any UI.
7. Web page: upload form, document picker (including "All documents"), question box,
   answers with citations.

### Phase 2
8. PDF support: text-based PDFs only; reject scanned PDFs with a clear message.
9. Hybrid search: add an Atlas Search (keyword) index and combine it with vector search.

### Phase 3
10. README with architecture diagram, and a demo video.

### Optional (parked)
11. Analytics: log each question, top score, and cited chunks in a `questions`
    collection, then build an analytics view with aggregation pipelines.

## Open decisions
- Schema: collections and field names. Decide before creating any test documents in
  milestone 2, because the vector index definition is built on these field names.
- Chunk size and overlap (decide before embedding lots of data; changing later means
  re-embedding everything)

## Current status
- Git installed; Atlas account set up. Milestone 1 is completed.
