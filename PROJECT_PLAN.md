# Project Plan: RAG Knowledge Base on MongoDB Atlas

## What we're building aka functional specifications
A personal knowledge base. Users upload files (text, markdown, PDFs) and ask
questions in plain language. The app answers using only their content and cites which
upload and section each answer came from.

Purpose: a solo portfolio project that showcases MongoDB Atlas capabilities,
especially Vector Search.

Supported uploads: .txt, .md, and text-based PDFs. Reject scanned PDFs and images
with a clear message.

Upload-scoped questions: all uploads are shared and visible to everyone (no logins).
The user ticks one or more uploads, or "All uploads", before asking; nothing is ticked
when the page opens. With uploads ticked, the search pre-filters by their uploadIds, so
answers come only from those uploads. With "All uploads", answers can come from any
searchable upload. Grounding rules below apply either way. Each question is answered
on its own (no follow-ups).

Grounding: answers must come only from retrieved chunks, with citations.
If retrieval scores are below a threshold, reply "not found in your uploads" without
calling the LLM. The threshold only catches clearly unrelated questions, so the LLM
also replies "not found in your uploads" when the retrieved chunks don't contain the
answer (see Findings: "Not found" score threshold).

Uploads are one-way: no delete or edit in the app. Uploading a file whose name already
exists is rejected with a message. Test data is cleaned up manually in Atlas.

Deployment: runs on localhost or a private VM for demos. It is not exposed publicly,
so no logins or usage limits are needed.

## Terminology
- MDB doc: a document in MongoDB's document model (a record in a collection).
- Upload: a file the user uploads (a document in the everyday sense).
- Chunk: a piece of an upload, stored as one MDB doc in the `chunks` collection.
- Avoid the bare word "document"; use one of the terms above.
- Documentation: official product documentation (e.g. "the Atlas documentation").
  Don't shorten it to "docs", which reads like "MDB docs".

## Tech stack
- Runtime: Node.js (LTS)
- Backend: Express 5 (catches errors in `async` route handlers itself); file uploads
  read with `multer` 2
- Database: MongoDB Atlas via the official MongoDB Node.js driver. An M10 cluster
  running MongoDB 9.0 since milestone 9; milestones 1–8 ran on the free M0 (8.0).
  See Findings: Cluster move.
- Frontend: plain HTML + JavaScript (no framework for now)
- Language: plain JavaScript (no TypeScript for now)
- Embeddings: Auto-Embedding with Voyage AI on MongoDB Atlas, model `voyage-4`.
  Switching models later means re-embedding everything. Uses a one-time free
  allocation of 200 million tokens per model (not monthly), so avoid unnecessary
  re-embedding.
- Reranking (milestone 9): the `$rerank` stage with Voyage AI `rerank-3` (GA since
  2026-09-29; the Atlas `$rerank` page still says Preview), run by Atlas outside the
  cluster; on for every answer by default. A one-time allocation of 200 million free
  tokens per organization, then $0.05 per million.
- Chunking: custom splitter (sections → paragraphs → sentences), sized in characters
  (≈4 characters per token). No library. Sections come from the extractor: Markdown
  headings, one per plain-text file, pages for PDFs.
- PDF extraction: `unpdf`, a pdf.js wrapper that works with `require` and gives text
  per page. Pages act as sections for citations. Scanned PDFs are rejected.
- Answer generation: Anthropic API with built-in citations; one call per question,
  skipped when retrieval scores are below the threshold. Model: Claude Sonnet 5.5
  (`claude-sonnet-5-5`).
- Secrets: stored in a `.env` file, never committed to git

## How it works
1. Ingest: user uploads a file; the app extracts text and splits it into overlapping
   chunks.
2. Store: each chunk is saved in Atlas with its text and metadata
   (uploadId, file name, section). The app does not create vectors.
3. Embed: Atlas Auto-Embedding converts each chunk's text to a vector with Voyage AI,
   through the vector search index.
4. Retrieve: the question is sent to Atlas as text; Atlas embeds it with the same
   model, and Vector Search finds the 50 closest chunks (pre-filtered by the uploadIds
   of the ticked uploads). The `$rerank` stage re-sorts them by how well each answers
   the question, and the top 10 go on.
5. Answer: if the best match scores below the threshold, reply "not found in your
   uploads". Otherwise the chunks and question go to the LLM, which answers with
   citations.

## MongoDB features to showcase
- Atlas Vector Search with Auto-Embedding, pre-filtered by upload (uploadId)
- Atlas Search autocomplete (fuzzy) on upload titles, for the picker's search
- Atlas Search facets on the picker: uploads counted by file type and size, as
  filters for the list and the title search (milestone 10)
- Hybrid search: vector search combined with Atlas Search (keyword/fuzzy) by
  `$rankFusion` (milestone 9; an option in the API and tools, results in
  `test/HYBRID.md`)
- Reranking with `$rerank` (Voyage AI) on every answer (milestone 9; results in
  `test/RERANKING.md`)
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
   Before creating the index: check the Atlas documentation for which changes trigger
   re-embedding (show the user the source), and check the M0 limit on search indexes
   (this project plans a vector and a keyword index). After embedding, measure M0
   storage use (512 MB limit).
4. Search from the command line: a question returns the top chunks with scores, for
   one upload or "All uploads". Test questions (answerable and not, each with the
   upload it should find) choose the "not found" threshold; milestone 9 reuses them to
   compare hybrid with vector-only search.
5. Answer: the threshold check, then the LLM answers with citations (upload + section),
   or replies "not found in your uploads" when the chunks don't contain the answer, a
   decision the code detects rather than reading the wording. Measure it with the test
   questions, including broad ones (summaries).
6. PDF support (command line): ingest text-based PDFs and reject scanned ones. Comes
   before the API and web page, so they are built once for all file types. Tune with a
   large real PDF (chunk count, delay, threshold, `search.limit`); drop running headers
   and footers, testing with mock PDFs.

### Phase 2
7. Express API: one shared database client; routes to upload, list, search titles,
   check readiness, ask, and check the database connection. Routes, formats, error
   codes and the `src/` changes this milestone needs are in API_SPEC.md; check it
   against the wireframe first, and update it as routes change. Test with curl before
   building any UI. Name the entry file `server.js` (not `index.js`), at the root,
   with the routes in `src/api/`, and point `npm start` at it; `package.json` needs
   no `main` field, since the app is run, never imported. Move the index definitions
   from `scripts/setup-db.js` into `src/indexes.js`, so the server can check at
   startup that the vector index exists.
   Add test questions for several ticked uploads, to check the threshold for selected
   uploads.
8. Web page in `public/`, built from the wireframe (`wireframe/index.html`): upload
   form, picker (several uploads or "All uploads", title search), question box,
   answers with citations and "How this was found". Show "processing… → ready" after
   upload, since new chunks are not searchable until their embeddings exist. Choose
   the colour scheme: blue (`index.html`) or MongoDB-style green (`index-green.html`).
   Use line icons, not emoji, which keep the operating system's colours. The wireframe
   sets the layout, the states and how the page behaves, not its code or exact
   styling; where it and API_SPEC.md differ, the spec wins. It isn't updated after
   milestone 7.
9. Better retrieval: rerank the top vector results with `$rerank` (Voyage AI; needs
   MongoDB 9.0+, M10+ and Native Reranking enabled), then add hybrid search (an Atlas Search keyword index combined with
   vector search, reranked last). Measure each against vector search alone with
   `test/questions.json`, and re-check the "not found" threshold. Then the web page:
   "How this was found" compares the passages sent to the LLM with the ones vector
   search alone would have sent.
10. Faceted upload picker: a Filter block above the title search, with Type (PDF, MD,
    TXT) and Size (Small, Medium, Large) chips whose counts come from Atlas Search
    facets, filtering the list and the title search. Built from `wireframe/index-facets.html` (the
    sidebar only; where it and API_SPEC.md differ, the spec wins; not updated after
    this milestone). Check the facet syntax in the Atlas documentation first. Steps:
    the title index gains the two fields, applied with a new
    `npm run setup -- --update <index name>`; then the facets route and the filters
    on title search, tested with curl; then the page. No test-question or answer
    runs: retrieval doesn't change.

### Phase 3
11. README with an architecture diagram and a Troubleshooting section, starting
    with: "SSL alert number 80" (tlsv1 alert internal error) when connecting means
    your IP address has changed; add it in Atlas Network Access. The driver may label
    it `SystemOverloadedError`, but it isn't an Atlas outage.
    For a portfolio reader: what it showcases, the diagram (Mermaid, with a box around
    what runs in Atlas), the vector search and rerank pipeline as example code, a
    short results summary, a quick start (M10 or larger with MongoDB 9.0+ and
    Native Reranking enabled, for `$rerank`), a screenshot of the page, and an MIT license. Links to the other
    files rather than repeating them. Re-measure rerank tokens per search on the Atlas
    dashboard and correct the estimate where it appears.

### Optional (parked)
12. Analytics: log each question, top score, and cited chunks in a `questions`
    collection, then build an analytics view with aggregation pipelines.

## Open decisions
- None.

## Decisions
- Database: `knowledge_base` (`DB_NAME` in `.env`).
- Schema: two collections, names in `config.js`.
  - `uploads`: `_id` (the uploadId), `fileName`, `title`, `fileType`, `status`
    (processing → complete), `uploadedAt`, `chunkCount`, `searchableAt` (milestone 7,
    see Web page and API: Readiness). `title` comes from the file (first `#` heading
    in Markdown, metadata title in a PDF), else from the file name.
  - `chunks`: `uploadId` (ObjectId), `fileName` (copied for citations), `section`,
    `chunkIndex`, `text` (Markdown: heading path + body; plain text: title + body;
    PDFs: title, chapter if any, + body; the auto-embedded field).
  - Indexes: `uploads` partial unique on `fileName` where status is complete;
    `chunks` on `uploadId`. The vector index filters on `uploadId` only.
  - Not indexed (milestone 7): `searchableAt` and `title`. `uploads` holds one MDB
    doc per file, so scanning it is trivial next to the vector search and the LLM. If
    it reaches thousands of MDB docs, or `explain` shows a slow scan, add a partial
    index on `searchableAt` (where it exists) for "All uploads", and one on `title`
    with the upload list's collation.
- Vector index `chunks_vector_cosine` on `chunks` (created by `npm run setup`):
  autoEmbed on `text`, model `voyage-4`, 1024 dimensions, scalar quantization, cosine
  similarity; filter on `uploadId` (queries must pass ObjectIds, not strings).
  It can't be edited (an autoEmbed field). Setup skips a search index that already
  exists, and updates one only when named with `--update` (milestone 10), never the
  vector index.
- Search indexes (milestone 7): three, chosen to fit the M0's 3 slots: the vector
  index, the keyword index (milestone 9), and `uploads_title_autocomplete` on
  `uploads` for the picker's title search (and its facets, milestone 10). The vector
  index stays as it is. The keyword and title indexes hold no embeddings, so a changed
  definition is applied in place with `npm run setup -- --update <index name>`
  (milestone 10): Atlas answers from the old version until the new one is built.
  M10 has no cap on search indexes, so a 4th index is
  possible now, though each one adds load on a small tier. Not chosen: filtering
  titles in the browser, which showcases nothing.
- Chunk size: 1,600 characters (≈400 tokens), max 2,000, overlap 200; values in
  `config.js`. Sections are hard boundaries (a chunk never spans two): each Markdown
  heading starts a section, a plain-text file is one section, and each PDF page is one
  (see PDF pages). Why 1,600: see Findings: Chunk size.
- Search (milestones 4, 7): ticked uploads use exact search (complete, and cheap
  within a few uploads); "All uploads" uses approximate search, filtered on the ids of
  searchable uploads (milestone 4: complete) rather than no filter, so orphan chunks,
  crash leftovers and half-embedded uploads never reach an answer. The LLM gets the
  top `search.limit` chunks (10), reranked from 50 since milestone 9.
- Reranking (milestone 9): on for every answer: `rerank-3`, 50 candidates, top 10 to
  the LLM; "not found" threshold 0.58 on the top rerank score, both modes (see
  Findings: Rerank threshold). Asked with `rerank: false` (API) or `--no-rerank`
  (command line), answers come from vector search alone at the cosine 0.62. Tied
  rerank scores are broken by the cosine score. No fallback to vector search alone:
  embedding the question needs Voyage AI too.
- Hybrid search (milestone 9): an option only (`search: "hybrid"`, `--search hybrid`),
  not the default or on the page: no gain (Findings). Details: `src/search.js`.
- PDF pages (milestone 6; detailed rules in the PDF extractor's header comment): each
  page is a section, cited by its PDF page number, and page breaks stay hard
  boundaries. Pages are read in visual order (some PDFs store code blocks after the
  prose). A sentence cut by a page break moves to the next page, unless either side of
  the break is code. Images are skipped and there's no OCR.
- PDF headers, footers and chapters (milestone 6): running headers and footers are
  dropped: margin lines that repeat on a run of nearby pages. A run, not a share of
  all pages, so chapter names go in long books too, while body sentences a book
  repeats on scattered pages stay. Chunks start with the title, not "page N", then the
  page's chapter when the headers name one ("Title > Chapter", like a Markdown heading
  path). The name moves from the body to the prefix so every chunk of the chapter
  carries it, header or not. Headers that never change (e.g. the book title) are
  ignored. The mock PDFs are committed; their generator is kept outside the
  repository. Not chosen: chapter names from the PDF outline (bookmarks);
  neither real PDF has one.
- Answers (milestone 5):
  - Chunks go to the LLM as search results with built-in citations, each titled
    "fileName: section", so every citation maps back to an upload and section. A
    citation quotes a whole chunk; if the web page needs shorter quotes, send chunks
    as paragraph blocks (no data change).
  - The system prompt treats uploaded text as material to answer from, never as
    instructions.
  - "Not found" is detected by citations: a reply with none is "not found in your
    uploads", whatever its wording. (Built-in citations can't be combined with
    structured output.) Fallback if citations prove unreliable: a "not found" tool.
  - Partial answers: the LLM answers the part the chunks cover, with citations, and
    says what the uploads don't cover. It counts as an answer.
- Facets (milestone 10; details in API_SPEC.md): the title index also holds
  `fileType` (`token`) and `chunkCount` (`number`), not the outdated `stringFacet` and
  `numberFacet` types. Size: under 10 chunks is Small, 10–99 Medium, 100 or more
  Large. Each row's counts apply the other row's chips, not its own, so a second value
  can still be added. The counts are for the whole library and don't follow the typed
  words: the list isn't narrowed by them, so a chip greyed for 0 matches would block a
  filter that works on the list. The filter only narrows what the picker shows; ticks and "All
  uploads" don't change. The list still comes from `GET /api/uploads`. If facets are
  unavailable, the Filter block is hidden.
- Web page and API (milestones 7–10; details, reasons and rejected options in
  API_SPEC.md):
  - Picker: several uploads or "All uploads"; nothing ticked when the page opens.
  - Readiness: search and count, saved as `searchableAt` by the page, `npm run ingest`
    and `npm run setup`; never from `status`.
  - `GET /api/health` tells a stopped server from an unreachable database.
  - Uploads: the request waits for the ingest; one at a time; 50 MB limit.
  - Answers: parts with citation numbers; "How this was found" on every answer.
    `retrieval.search` names the kind of search (vector or hybrid), separate from
    `mode` (exact or approximate), and `retrieval.rerank` the reranking (milestone 9).
  - Questions are standalone; no follow-ups.
  - Earlier questions are kept in the browser (`localStorage`), not in Atlas.
  - The server listens on `127.0.0.1` unless `HOST` is set.
  - The page (milestone 8): plain browser modules, no build step or framework; green
    scheme; recovers by itself when the server or database comes back.
  - Comparison (milestone 9): "How this was found" shows the reranked passages and
    vector search alone's in two tabs, from the same search
    (`retrieval.withoutRerank`): no second request or LLM call.
- Folder layout (milestone 3). Scripts and tools import from `src/`, never the reverse.
  `src/` is app code; `scripts/` is what's needed to make the app work (setup, and the
  user-facing commands ingest and ask until the web page); `tools/` is maintenance and
  testing, including everything that shows the app's internals (e.g. the command-line
  search); `server.js` at the root starts the API server, whose routes are in
  `src/api/` (milestone 7); `public/` is the web page (milestone 8); `wireframe/` is
  the static mock-up it's built from. ARCHITECTURE.md maps each folder and file.

## Findings
Measured results and the values chosen from them, with a short reason. Filled in as
milestones run.
- Embedding delay (milestones 3, 6): from upload to fully searchable, about 5–11 s for
  small uploads and 13–16 s for the 313-chunk book, ingest included; it barely grows
  with size. Embedding beyond the rate limit is queued, so very large uploads take
  longer. Building the vector index over 17 existing chunks took about 80 s.
- Exact vs approximate search (milestones 3, 6, Atlas documentation + test):
  approximate search (the default) can miss results (90–95% overlap with exact is
  typical), so it can't be trusted to count chunks. Exact search checks every vector
  that passes the filter; the documentation recommends it below 10,000 MDB docs and
  for selective pre-filters. On our index both give the same scores (within ~0.001
  run-to-run jitter). Exact search has no documented cap on `limit` (313 returned all
  of the book's chunks); `numCandidates` (approximate only) is capped at 10,000.
- Upload size (milestones 3, 6): the 280-page book gave 313 chunks, about 1.1 per
  page, since most of its pages (~1,200 characters) fit in one chunk. Dense textbooks
  (≈3,000–3,500 characters per page, estimated) would give 1,200–1,800 chunks per
  500 pages, up to ~2,500 when very dense.
- Similarity (milestone 3): dotProduct with scalar quantization squeezed every score
  to about 0.50 (relevant vs off-topic differed by ~0.003). Cosine separates them
  (about 0.67–0.72 vs 0.55–0.58), with the same ranking. Chose cosine.
- Re-embedding triggers (milestone 3, Atlas documentation): inserting a chunk or
  changing its `text` embeds that chunk; changing other fields or deleting does not.
  Changing the model, embedded path, dimensions or quantization rebuilds and re-embeds
  everything. An autoEmbed field can't be edited. Adding filter fields later isn't
  documented. Dropping an index also removes its stored embeddings.
- Cluster limits (milestone 3; Atlas documentation): M0 allows 3 search indexes
  (vector and keyword together); M10 and above have no cap, but many indexes can slow
  a small tier or run it out of memory. Auto-Embedding needs no extra setup on either
  (see Decisions: Search indexes).
- Storage (milestones 3, 6): measured ~5.5 KB per chunk worst case, all-in (data
  2.4 KB, with indexes and generated embeddings ~4.5 KB on disk, plus ~1.1 KB of
  vector index); the book takes ~1.7 MB. 512 MB holds ~90,000 chunks, fewer than the
  200M-token allowance would embed (~500,000), so storage is the tighter limit, but
  not a concern at this project's scale. Unknown: whether M0 counts the embeddings
  and the vector index toward 512 MB. Measured on M0; M10's storage (10 GB by
  default) makes it a non-issue.
- "Not found" score threshold (milestones 4, 6; runs of 2026-09-29 and 2026-10-01):
  since milestone 9 it applies only to answers without reranking (cosine scores);
  reranked answers use 0.58 (Findings: Rerank threshold). 0.62 for both search modes,
  which scored almost the same (two config entries, so
  they can diverge, e.g. for hybrid). Answerable questions scored 0.65–0.86 and
  clearly unrelated ones 0.58–0.61, so it rejects those and most questions asked of
  the wrong upload. But near-misses (on topic, answer absent: 0.68–0.80) and technical
  off-topic questions (up to 0.77) overlap the answerable ones: the top score measures
  topic, not whether the answer is present. So the LLM is the real "not found" gate.
  Set low on purpose: too high refuses real answers, which nothing recovers; too low
  costs one LLM call. With the PDFs it still keeps every answerable question, but no
  longer rejects off-topic ones in All uploads (0.62–0.67), lifted by low-content
  chunks. More chunks give an off-topic question a higher best match, so expect this
  drift as uploads grow.
- Chunk size (milestones 4–6; runs of 2026-09-29): kept 1,600 after comparing it with
  1,000. Retrieval tied (the answer in the top 5 for all 22 questions at both sizes).
  1,000 scored higher and put the expected upload first slightly more often (22 vs 20
  of 22), but those answers were found at 1,600 too. So 1,600 won on the rest: more
  context for the LLM, about 30% less storage, slightly better threshold behaviour,
  and more context for PDF chunks, which have no heading path. Broad questions
  (milestone 5) agree. In PDFs, pages are hard boundaries and few are longer than a
  chunk, so the size barely matters; short chunks (part openers, page ends) hold real
  content, so they aren't merged. One weak retrieval: a book answer on a mostly-code
  page ranks #10, behind symbol-only cheatsheet pages; try neighbour expansion (send
  each hit with the chunks at `chunkIndex` ± 1) or hybrid search (milestone 9).
  Reranking (milestone 9) moved it to #5.
- Answers (milestones 5–7; runs of 2026-09-29, 2026-10-01 and 2026-10-05): all 112
  question/mode pairs passed; with the PDFs, 188 of 191 (the 3 failures were badly
  designed questions, since fixed); after milestone 7's search and answer changes,
  with several ticked uploads added, 203 of 203. The LLM replied "not found" to every
  near-miss and off-topic question the threshold let through (up to 0.80), so
  threshold plus LLM work as planned. Detecting "not found" by citations held, and
  partial answers named their missing part. With reranking (milestone 9), no full
  answer run was made, to save cost; a run of the 7 questions whose top 10 changed
  most passed 19 of 19 question/mode pairs (runs of 2026-10-09).
- Answer prompt (milestone 5; runs of 2026-09-29): tuned against unasked gap notes, an
  invented example value and long answers; the kept rules are in the system prompt.
  Accepted: proxy answers note that no exact syntax is given. Replies vary between
  runs, so judge prompt changes on a full run.
- LLM cost (milestone 5): billing implies ~$2 / $10 per million input / output tokens.
  Input dominates (~5,300 tokens per question at `search.limit` 10, mostly the
  chunks); a full run of the answer tests (71 questions) is ~150 calls, ~$2.
- Broad questions (milestones 5–6): limited by how many chunks reach the LLM, not by
  chunk size. `search.limit` raised from 5 to 10 in milestone 6 (runs of 2026-10-01):
  uploads of 10–13 chunks now get complete answers; the book's stay partial. "What
  kinds of examples does the book include?" stays incomplete at any limit (no table
  of contents in its text). Cost: ~$0.003 more per question. Reranked (milestone 9),
  that question finds the book's list of example chapters and names about a dozen.
- Scanned PDFs (milestone 6): rejected as intended, tested with image-only mock PDFs,
  including one with a small text footer as phone scanner apps add. A text PDF with a
  few image-only pages (a cover, a diagram) is accepted; those pages give no section.
  Rejection happens before anything is saved.
- Plain-text chunk prefix (milestone 6): changed from the file name
  ("nimbus-admin-handbook.txt") to the title made from it ("Nimbus Admin Handbook"),
  to match PDFs. No measurable effect (runs of 2026-10-01): ranks, answers and the
  threshold unchanged; scores of the plain-text uploads' own questions moved by
  -0.006 to +0.006, mostly slightly down. Kept for consistency.
- Several ticked uploads (milestone 7; runs of 2026-10-05): kept 0.62 for selected
  uploads. 11 questions got a `several` list of 2–3 uploads to search together: 7
  with an answering upload among distractors (same topic or not), 4 without one
  (near-misses, off-topic, and an answerable question with its upload left out). All 7
  stayed above the threshold, with the answering upload ranked #1. More ticked uploads
  raise an unrelated question's best match (0.63 with one wrong upload, 0.68 with
  two), so none of the 4 fell below it; the LLM replied "not found" to all 4. All 11
  passed in the full answer run.
- Cluster move (before milestone 9; run of 2026-10-09, `m10-baseline`): the data was
  moved from M0 to an M10 (MongoDB 9.0.4) with mongodump and mongorestore. A dump
  holds the chunks' text but not their embeddings, which live in the vector index, so
  M10 embedded all 360 chunks again with the same model. Compared with the M0 run of
  2026-10-05: ranks, answer positions and every threshold result unchanged; all
  scores within the ~0.001 jitter except one off-topic All uploads score (0.6270 →
  0.6211, still kept by 0.62), probably because two test uploads (6 chunks) were in
  the M0 run and not this one. No answer run needed, since the same chunks reach the
  LLM. This run is milestone 9's vector-only baseline.
- Reranking (milestone 9; runs of 2026-10-09; details and charts in
  `test/RERANKING.md`): the answer text comes first for 40 of 43 questions (vector
  search alone: 33 in All uploads, 36 in one upload), the expected upload first for 50
  of 50 (was 48). Rerank scores separate answers from non-answers, which cosine scores
  didn't: unanswerable questions scoring at or above the lowest answer dropped from 16
  to 2, and unrelated chunks sit near 0.25 (cosine: about 0.59). 20 and 50 candidates
  gave practically the same results; 50 leaves room for large uploads. Cost: about
  11,000 rerank tokens per search of 50 candidates (measured 2026-11-04: 10,765 on
  the Atlas dashboard for one All uploads search; the earlier estimate of 20,000 was
  about twice too high) and about 300 ms (estimate).
- Rerank threshold (milestone 9; runs of 2026-10-09): 0.58 for both search modes. It
  sends all 50 answerable questions to the LLM (lowest 0.637, a margin of 0.057) and
  stops every wrong-upload, off-topic and several-uploads-without-the-answer search,
  and 10 of 12 near-misses (vector search alone at 0.62 stopped 38 of 50 wrong
  uploads, 0 to 3 of 9 off-topic, and none of the others). 0.62 would stop the same, but at 20 candidates a real answer
  scored one score step above it. The 2 near-misses still sent to the LLM got "not
  found" from it. On 2026-10-09 rerank scores were rounded to steps of 1/256 (ties
  common); by 2026-10-21 they came at full precision on the same scale. Re-checked
  then with 77 questions (`2026-10-21-vector-rerank`): same outcomes, lowest
  answerable 0.638.
- Hybrid search (milestone 9; runs of 2026-10-21, details in `test/HYBRID.md`): no
  measurable gain with reranking last. Vector + rerank and hybrid + rerank gave the
  same results on every check (77 questions, 6 of them new `keyword` questions about
  exact identifiers), and the 10 chunks sent to the LLM were the same for 59 of 77
  questions, never different in the top 3; the 26 chunks only hybrid sent were all
  unrelated. Every answer was already among vector search's 50 candidates, and the
  reranker decides the order. Costs about 1.6 times the rerank tokens (merged lists of
  67–96 chunks). The 0.58 threshold serves both. It could matter with a much larger
  library, or codes vector search handles badly.
- Per-chunk floor (milestone 9; measured 2026-10-21, not adopted): the threshold
  checks only the top chunk, and #2–#10 go to the LLM whatever their score. Sending
  only chunks at or above a floor lost no answer chunk up to 0.50 (lowest 0.514); 0.45
  would cut about 15% of the LLM's input, about $0.002 per question. Not adopted: a
  small saving, it also drops related same-upload chunks, filler hasn't caused a wrong
  answer, and it would need an answer run.
- Facets (milestone 10; 2026-11-03): the counts matched a plain count of the 7
  uploads. Updating the title index in place took under two minutes, BUILDING but
  queryable throughout, so title search kept answering. On a missing index
  `$searchMeta` returns no facets, and a facet on a field the index doesn't hold as
  `token` or `number` fails with "Cannot facet on field…"; the facets route turns both
  into `facetsUnavailable`.

## Current status
- Git installed; Atlas account set up. Milestone 1 is completed.
- Milestone 2 is completed: `npm run ingest -- <file>` saves .txt and .md uploads and
  their chunks.
- Milestone 3 is completed: the vector index `chunks_vector_cosine` is ready (see
  Decisions), and delay, storage and search behaviour are under Findings.
- Milestone 4 is completed: `src/search.js` searches one upload (exact) or all complete
  uploads (approximate); `npm run search` shows raw results; `npm run test-questions`
  runs the 36 questions in `test/questions.json` and saves reports in `test/results/`.
  The "not found" threshold (0.62) and the chunk size (1,600) are under Findings.
- Milestone 5 is completed: `src/answer.js` answers with citations; `npm run ask`;
  `npm run test-answers` checks answers against `test/questions.json` (42 questions,
  new kinds partial and broad). Results under Findings.
- Milestone 6 is completed: PDF ingestion with running headers and footers dropped and
  chapter names in the prefix (see Decisions: PDF pages, and PDF headers, footers and
  chapters), and the tuning (threshold kept at 0.62, `search.limit` 10, chunk size
  kept; under Findings). In Atlas, 360 chunks: the five samples (37) plus two real
  PDFs. The test set has 71 questions.
- Before milestone 7: a static wireframe of the web page (`wireframe/index.html`)
  settled what the page needs from the API; the decisions are under Decisions (Web
  page and API, Search indexes), the routes and formats in API_SPEC.md.
- Milestone 7 is completed: the Express API (`npm start`, `server.js` and `src/api/`)
  with every route in API_SPEC.md, tested with curl: health, the upload list, title
  search (Atlas Search autocomplete, the M0's second search index), readiness
  (`searchableAt`, also set by `npm run setup` and `npm run ingest`), uploads, and
  questions for several uploads or all. Answers come as parts, citations and
  "How this was found" details. The threshold holds for several uploads (Findings:
  Several ticked uploads); a full answer run passed 203 of 203.
- Milestone 8 is completed: the web page in `public/` (`npm start`, then
  `http://127.0.0.1:3000`), built from the green wireframe: uploads by button or drag
  and drop with "processing… → ready", the picker with title search, questions with
  cited answers and "How this was found", earlier questions saved in the browser, and
  banners that clear by themselves when the server or database comes back. Checked in
  the browser against the running server (no front-end tests); the page's behaviours
  are in API_SPEC.md.
- Before milestone 9: moved to an M10 cluster (MongoDB 9.0), where `$rerank` is
  generally available. Search scores unchanged (Findings: Cluster move); the run
  `2026-10-09-m10-baseline` is the vector-only baseline for milestone 9.
- Milestone 9 is completed: reranking is on for every answer (Decisions: Reranking;
  Findings: Reranking, Rerank threshold; `test/RERANKING.md`); the API and command
  line can still answer without it (`rerank: false`, `--no-rerank`). Hybrid search is
  an option in the API and command line (`search: "hybrid"`, `--search hybrid`; the
  keyword index `chunks_keyword` is the M10's third search index); it showed no gain,
  so it isn't the default (Decisions and Findings: Hybrid search; `test/HYBRID.md`).
  On the page, "How this was found" compares the reranked passages with vector search
  alone's, in two tabs (Decisions: Web page and API), and answers show code blocks
  formatted. The test set has 77 questions.
- Milestone 10 is completed: the Filter block on the page (Type and Size chips with
  counts from Atlas Search facets; Decisions: Facets),
  the route `GET /api/uploads/facets` and the chips as filters on title search, tested
  with curl and checked in the browser. The title index gained `fileType` and
  `chunkCount`, applied with the new `npm run setup -- --update <index name>`.
- Milestone 11 is completed: the README (what the app showcases, a Mermaid
  architecture diagram, the vector search + rerank pipeline and the picker's title
  search and facets queries as example code, run against Atlas as written, the
  reranking results with both charts, a quick start and Troubleshooting), a
  screenshot of the page in `images/`, and the MIT license. Rerank tokens re-measured:
  about 11,000 per search (Findings: Reranking). Hybrid search isn't in the README,
  since the page doesn't use it.
- Next: nothing planned; milestone 12 (analytics) is parked.
- Files and commands: see ARCHITECTURE.md.
