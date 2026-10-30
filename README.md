# RAG knowledge base on MongoDB Atlas

Upload text files, Markdown and text-based PDFs, then ask questions in plain
language. The app answers only from your uploads, and every answer cites the upload
and section it came from. If the uploads don't hold the answer, it says
"not found in your uploads" instead of guessing.

A solo portfolio project that shows what MongoDB Atlas can do for retrieval:
Vector Search with Auto-Embedding, reranking with `$rerank`, and hybrid search with
`$rankFusion`. Answers are written by Claude (Anthropic API) with built-in citations.

![The web page: a question about removing array elements, answered from a book PDF with numbered citations, and "How this was found" open, comparing the reranked passages with vector search alone's.](images/answer.png)

## What it showcases

- **Atlas Vector Search with Auto-Embedding.** The app stores only chunk text. Atlas
  embeds it with Voyage AI (`voyage-4`) through the vector search index, and embeds
  each question the same way, so the app never creates or handles a vector.
- **Pre-filtered search.** The user ticks one or more uploads, or "All uploads", and
  the search is filtered on their ids. Ticked uploads use exact search; "All uploads"
  uses approximate search.
- **Reranking with `$rerank`.** Vector search fetches 50 candidates; the aggregation
  stage `$rerank` (Voyage AI `rerank-3`, run by Atlas) re-sorts them by how well each
  answers the question, and the top 10 go to the LLM. On for every answer.
- **A "not found" threshold on the rerank score.** Below it, the app answers "not
  found" without calling the LLM.
- **Hybrid search with `$rankFusion`.** Vector search and Atlas Search keyword search
  merged, then reranked. An option in the API and command line; it made no
  measurable difference here ([test/HYBRID.md](test/HYBRID.md)).
- **Atlas Search autocomplete.** Typo-tolerant title search in the page's upload
  picker.

## How it works

```mermaid
flowchart TB
  file(["Upload: .txt, .md, PDF"]) --> split["Node.js app: extractor + splitter<br/>sections → overlapping chunks"]
  question(["Question + ticked uploads"])

  subgraph atlas["MongoDB Atlas"]
    chunks[("chunks collection<br/>text, upload, section")] --> embed["Auto-Embedding<br/>Voyage AI voyage-4"]
    embed --> vindex[("Vector search index<br/>chunks_vector_cosine")]
    vindex -.-> vs["$vectorSearch<br/>50 closest chunks in the ticked uploads"]
    vs --> rr["$rerank<br/>Voyage AI rerank-3, top 10"]
  end

  split --> chunks
  question --> vs
  rr --> threshold{"Node.js app:<br/>top rerank score ≥ 0.58?"}
  threshold -- "sent to the LLM" --> llm["Claude (Anthropic API)<br/>answer with citations"]
  threshold -- "stopped" --> notfound(["not found in your uploads"])
```

1. **Ingest.** An extractor per file type splits the upload into sections (Markdown
   headings, PDF pages, or the whole plain-text file), and a splitter cuts each
   section into overlapping chunks. Each chunk is saved as one MongoDB document with
   its text, upload id, file name and section.
2. **Embed.** Atlas embeds each new chunk in the background, through the vector
   search index. A new upload becomes searchable a few seconds later; the page shows
   "processing… → ready".
3. **Search.** The question goes to Atlas as text. `$vectorSearch` finds the 50
   closest chunks within the ticked uploads, and `$rerank` re-sorts them.
4. **Answer.** If the best rerank score is below the threshold, the question is
   stopped: the app replies "not found in your uploads" and the LLM isn't called.
   Otherwise the top 10 chunks are sent to the LLM as search results, and Claude
   answers with citations that map back to an upload and section. A reply with no
   citations also counts as "not found".

[ARCHITECTURE.md](ARCHITECTURE.md) maps every file and command, and
[API_SPEC.md](API_SPEC.md) describes the API's routes and the web page's behaviour.

## The search pipeline, in code

Simplified from [src/search.js](src/search.js), which also numbers each chunk's rank
before and after reranking, counts the candidates and joins each chunk's upload.
Node.js driver syntax.

**The vector search index** (from [src/indexes.js](src/indexes.js)). The `autoEmbed`
field tells Atlas to embed `text` itself; `uploadId` is a filter field, so searches can
be limited to some uploads.

```js
await db.collection('chunks').createSearchIndex({
  name: 'chunks_vector_cosine',
  type: 'vectorSearch',
  definition: {
    fields: [
      {
        type: 'autoEmbed',
        modality: 'text',
        path: 'text',            // the field Atlas embeds
        model: 'voyage-4',
        numDimensions: 1024,
        quantization: 'scalar',
        similarity: 'cosine',
      },
      { type: 'filter', path: 'uploadId' },
    ],
  },
});
```

**Vector search, then rerank.** Both stages take the question as text: Atlas embeds
it for `$vectorSearch`, and the reranker reads it next to each candidate's text.

```js
const results = await db.collection('chunks').aggregate([
  {
    $vectorSearch: {
      index: 'chunks_vector_cosine',
      path: 'text',
      query: { text: question },                  // embedded by Atlas, no vector needed
      filter: { uploadId: { $in: uploadIds } },   // ObjectIds; strings match nothing
      exact: true,                                // a few uploads: check every chunk
      // numCandidates: 1000,                     // approximate search instead (All uploads)
      limit: 50,                                  // the candidates for reranking
    },
  },
  {
    $project: {
      fileName: 1, section: 1, text: 1,
      vectorScore: { $meta: 'vectorSearchScore' },   // cosine similarity
    },
  },
  {
    $rerank: {
      query: { text: question },
      path: 'text',             // what the reranker reads
      numDocsToRerank: 50,
      model: 'rerank-3',
    },
  },
  { $set: { score: { $meta: 'score' } } },     // the rerank score replaces the search score
  { $sort: { score: -1, vectorScore: -1 } },   // the cosine score breaks ties
  { $limit: 10 },                              // what goes to the LLM
]).toArray();
```

**The threshold check** (from [src/answer.js](src/answer.js)). Rerank scores separate
answers from unrelated chunks far better than cosine scores do, so one number stops
most unanswerable questions before the LLM is called.

```js
if (!results.length || results[0].score < 0.58) {
  return 'not found in your uploads';   // stopped: no LLM call
}
```

**Hybrid search.** `$rankFusion` runs vector search and keyword search (Atlas Search
index `chunks_keyword`) as two input pipelines and merges their results by rank
(Reciprocal Rank Fusion); `$rerank` then re-sorts the merged list.

```js
const results = await db.collection('chunks').aggregate([
  {
    $rankFusion: {
      input: {
        pipelines: {
          vector: [{ $vectorSearch: { /* as above, limit: 50 */ } }],
          keyword: [
            {
              $search: {
                index: 'chunks_keyword',
                compound: {
                  must: [{ text: { query: question, path: 'text', fuzzy: { maxEdits: 1 } } }],
                  filter: [{ in: { path: 'uploadId', value: uploadIds } }],
                },
              },
            },
            { $limit: 50 },
          ],
        },
      },
    },
  },
  { $rerank: { query: { text: question }, path: 'text', numDocsToRerank: 100, model: 'rerank-3' } },
  { $set: { score: { $meta: 'score' } } },
  { $sort: { score: -1 } },
  { $limit: 10 },
]).toArray();
```

## Results

Measured with 71 test questions ([test/questions.json](test/questions.json)) against
7 uploads (360 chunks), each searched in All uploads, in its own upload and in a
wrong one:

- **Reranking puts the answer first more often:** for 40 of 43 questions, against 33
  with vector search alone (All uploads).
- **Rerank scores make the threshold useful.** At 0.58, every answerable question is
  sent to the LLM, and every wrong-upload and off-topic search is stopped. With cosine
  scores, most of those had to be sent to the LLM, which replied "not found" itself:
  in a full test run, questions with no answer in the searched uploads reached the LLM
  55 times with vector search alone and 4 times reranked.
- **Hybrid search added nothing here:** with reranking last, the same results on
  every check, at about 1.6 times the rerank tokens.

![Bar chart: share of test questions that come out right per check, vector search alone vs reranked. Ranking: answer first 33 vs 40 of 43 (All uploads), 36 vs 40 (one upload), expected upload first 48 vs 50 of 50. Threshold: answerable questions sent to the LLM 50 of 50 both; stopped before the LLM: wrong upload 38 vs 50 of 50, near-miss 0 vs 10 of 12, off-topic 3 vs 9 of 9, several uploads without the answer 0 vs 4 of 4.](test/charts/rerank-before-after.svg)

The full comparisons: [test/RERANKING.md](test/RERANKING.md) and
[test/HYBRID.md](test/HYBRID.md). Decisions, measurements and the reasons behind each
setting: [PROJECT_PLAN.md](PROJECT_PLAN.md).

## Quick start

**You need:**

- Node.js 22 LTS or later.
- A MongoDB Atlas cluster with **MongoDB 8.3 or later** for `$rerank`, which means
  M10 or larger, a paid tier. On the free M0 (MongoDB 8.0), ingesting and searching
  work, but answers fail unless asked without reranking (`npm run ask -- "…"
  --no-rerank`), and the web page always reranks. Auto-Embedding and reranking need
  no Voyage AI account: Atlas runs both, each with a one-time free allowance of 200
  million tokens.
- Your IP address in Atlas **Network Access**.
- An Anthropic API key.

**Steps:**

1. Install the dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in `MONGODB_URI` and `ANTHROPIC_API_KEY`.
3. Create the collections and indexes. The search indexes build in the background;
   `npm run index-status` shows when they're ready.

   ```bash
   npm run setup
   ```

4. Upload the samples (small files on unrelated topics, so searches have
   distractors), or your own files from the web page:

   ```bash
   npm run ingest -- samples/nimbus-guide.md
   ```

5. Start the server and open `http://127.0.0.1:3000`:

   ```bash
   npm start
   ```

Or ask from the command line:

```bash
npm run ask -- "How do I set up a proxy for Nimbus?"
```

Each question with an answer is one LLM call, about $0.01–0.015 with Claude Sonnet
5.5. A question stopped by the threshold costs nothing.

The test questions also cover two PDFs that aren't in the repository (they're
copyrighted), so `npm run test-questions` gives different results on a fresh clone.

## Troubleshooting

**"SSL alert number 80" (`tlsv1 alert internal error`) when connecting.** Your IP
address has changed: add the new one in Atlas Network Access. The driver may label
this `SystemOverloadedError`, but it isn't an Atlas outage.

**Every question fails, on the page and with `npm run ask`, but
`npm run ask -- "…" --no-rerank` works.** The cluster runs a MongoDB version below
8.3, which has no `$rerank` stage (the free M0 runs 8.0). Use an M10 or larger with
8.3+, or ask from the command line with `--no-rerank`.

**LLM requests go to the wrong address, though `.env` looks right.** A variable
already set in your shell wins over `.env`. Some tools set `ANTHROPIC_BASE_URL`
themselves (the Claude desktop app's shell sets it to `https://api.anthropic.com`).
Check with:

```bash
node -e "console.log(process.env.ANTHROPIC_BASE_URL)"
```

**The page says the LLM "didn't accept this server's key", through a company
gateway.** A gateway set in `ANTHROPIC_BASE_URL` may answer `403` (for example
`RBAC: access denied`) when the app runs outside its network. Connect to the company
network or VPN, or use the Anthropic API directly (leave `ANTHROPIC_BASE_URL` unset).

## License

[MIT](LICENSE)
