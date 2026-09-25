# Project Plan: RAG Knowledge Base on MongoDB Atlas

## What we're building
A personal knowledge base. Users upload documents (text, markdown, later PDFs) and ask
questions in plain language. The app answers using only their content and cites which
document and section each answer came from.

Purpose: a solo portfolio project that showcases MongoDB Atlas capabilities,
especially Vector Search.

## Tech stack
- Runtime: Node.js (LTS)
- Backend: Express
- Database: MongoDB Atlas (free M0 cluster) via the official MongoDB Node.js driver
- Frontend: plain HTML + JavaScript (no framework for now)
- Language: plain JavaScript (no TypeScript for now)
- Embeddings: Voyage AI or OpenAI (not yet decided)
- Answer generation: Anthropic API
- Secrets: stored in a `.env` file, never committed to git

## How it works
1. Ingest: user uploads a file; the app extracts text and splits it into overlapping chunks.
2. Embed: each chunk is converted to a vector by the embedding model.
3. Store: each chunk is saved in Atlas with its text, vector, and metadata
   (source file, section, tags, upload date).
4. Retrieve: the question is embedded the same way; Atlas Vector Search finds the
   closest chunks.
5. Answer: the chunks and question go to the LLM, which answers with citations.

## MongoDB features to showcase
- Atlas Vector Search, with pre-filtering by metadata (document, tag, date)
- Hybrid search: vector search combined with Atlas Search (keyword/fuzzy)
- Flexible document model: text, vector, and metadata in one document
- Aggregation pipeline: analytics (most-asked questions, most-cited documents,
  questions with no good match)
- Optional: change streams or Atlas Triggers to re-embed notes when edited

## Milestones
1. Connect to Atlas, insert one test note, read it back. (No AI yet.)
2. Generate embeddings for notes and store them.
3. Create a vector search index and run a similarity search.
4. Generate answers with an LLM, including citations.
5. Simple web page: upload, ask, see answers.
6. Phase 2: PDF support, metadata filters, hybrid search.
7. Phase 3: analytics view, auto re-embedding on edit, README with architecture diagram,
   demo video.

## Open decisions
- Embedding provider (Voyage AI vs OpenAI)
- Chunk size and overlap (decide before embedding lots of data; changing later means
  re-embedding everything)

## Current status
- Git installed; Atlas account set up. Milestone 1 is completed.
