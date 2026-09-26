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
- Aggregation pipeline: analytics (most-asked questions, most-cited documents,
  questions with no good match)

## Milestones
1. Connect to Atlas, insert one test note, read it back. (No AI yet.)
2. Store a few test chunks and create a vector search index with Auto-Embedding.
3. Run a similarity search from a text question, with and without the uploadId filter.
4. Generate answers with an LLM, including citations.
5. Simple web page: upload, ask, see answers.
6. Phase 2: PDF support, metadata filters, hybrid search.
7. Phase 3: analytics view, README with architecture diagram,
   demo video.

## Open decisions
- Schema: collections and field names. Decide before creating any test documents in
  milestone 2, because the vector index definition is built on these field names.
- Chunk size and overlap (decide before embedding lots of data; changing later means
  re-embedding everything)

## Current status
- Git installed; Atlas account set up. Milestone 1 is completed.
