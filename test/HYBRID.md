# Hybrid search vs vector search, both reranked

What adding keyword search (hybrid search: Atlas Search combined with Atlas Vector
Search by `$rankFusion`) changed for this project's answers, with reranking (`$rerank`,
`rerank-3`) last in both, measured on the test questions in milestone 9 (runs of
2026-10-21, MongoDB 9.0 on an M10 cluster). Every number comes from the saved reports
listed under Sources, or from the one-off comparisons described below, unless it's
marked as an estimate.

## In short

- **No measurable gain.** The two runs give the same result on every check: the same
  top score, the same position of the answer and of the expected upload, and the same
  threshold outcome, for all 77 questions in every mode.
- **The LLM mostly gets the same chunks.** For 59 of 77 questions the 10 chunks sent
  to the LLM are identical, in the same order. Where they differ, it's usually one
  chunk near the bottom, never in the top 3.
- **The extra chunks didn't help.** None of the 26 chunks that only hybrid search sent
  to the LLM were useful (25 of them found only by keyword search); in 2 questions one
  pushed out a related chunk.
- **It costs more.** About 1.6 times the rerank tokens of vector search, plus the
  keyword search itself.
- **Why:** the reranker decides the order, and every answer was already among vector
  search's 50 candidates, so keyword search could only add candidates the reranker
  ranked lower.

So answers stay on vector search + rerank, and hybrid search stays an option in the
API and the command-line tools.

## How hybrid search works

Two searches run on the same uploads, then one merge, then the reranker
(`src/search.js`):

```
$rankFusion ┬ vector:  $vectorSearch (top 50)
            └ keyword: $search on chunks_keyword (top 50)
     → each chunk once (50 to 100)  →  $rerank (rerank-3, all of them)  →  top 10 to the LLM
```

- **Keyword search** is an Atlas Search index (`chunks_keyword`) on each chunk's text,
  with the `lucene.english` analyzer (lowercase, common words dropped, base word forms:
  "limits" finds "limit") and one-letter typo tolerance. It finds chunks that share
  words with the question, scored by how rare and frequent those words are.
- **`$rankFusion`** merges the two lists by position (Reciprocal Rank Fusion): each
  list adds 1 / (60 + the chunk's rank), so the merged score runs from about 0.009 to
  0.033 and says nothing about relevance.
- **The whole merged list is reranked**, not cut to 50 first: a chunk on both lists
  always outranks one on a single list (at least 2/110 vs at most 1/61), so a cut would
  drop the tail of each list, including vector results that vector search alone
  reranks.
- **Always reranked.** The merged score depends only on ranks, so no threshold can use
  it; the "not found" check reads the top rerank score, as in vector search.

Each hit records its place in each list (`vectorRank`, `keywordRank`) and the merged
score (`fusionScore`), copied out of `$rankFusion`'s `scoreDetails`.

## Test setup

- 7 uploads, 360 chunks: five small samples (Markdown, plain text), a 10-page sewing
  pattern PDF and a 280-page book PDF (313 chunks).
- 77 test questions ([questions.json](questions.json)): the 71 used for reranking,
  plus 6 of a new kind, `keyword`, about an exact identifier with little else to go
  on, where keyword search should help most: a config key (`parallel_uploads`), an
  environment variable (`NIMBUS_POLL_INTERVAL`), two command flags (`nimbus status
  --why`, `claude --continue`), a stage name (`$indexStats`, which the book also names,
  only in a list of stages it leaves out), and a flag that doesn't exist (`nimbus sync
  --force`, not answerable).
- Each question is searched in All uploads, in its own upload, in a wrong upload
  (answerable ones), and for 11 of them with several uploads ticked together.
- Both runs on the same day, both reranked (50 candidates from each search), threshold
  0.58 on the rerank score. Same-day runs, because `rerank-3` scores changed precision
  since the reranking runs of 2026-10-09 (they're no longer rounded to steps of 1/256).

## Results

| Check | Vector + rerank | Hybrid + rerank |
|---|---|---|
| Expected upload first (All) | 55 of 55 | 55 of 55 |
| Answer text in the top 10 (All / One) | 48 / 48 of 48 | 48 / 48 of 48 |
| Answer text first (All / One) | 44 / 44 of 48 | 44 / 44 of 48 |
| Answerable questions sent to the LLM | 55 of 55 | 55 of 55 |
| Lowest answerable score | 0.638 | 0.638 |
| Wrong upload stopped | 55 of 55 | 55 of 55 |
| Near-misses stopped (All / One) | 10 / 10 of 12 | 10 / 10 of 12 |
| Off-topic stopped (All / One) | 9 / 9 of 9 | 9 / 9 of 9 |
| `nimbus sync --force` (no such flag) stopped | yes (0.551) | yes (0.551) |
| Several ticked: one has the answer, sent / none has it, stopped | 7 of 7 / 4 of 4 | 7 of 7 / 4 of 4 |

The only difference between the two reports is one top score: `guide-proxy` in All
uploads, 0.8543 vs 0.8540, the reranker's run-to-run noise.

The answers not in first place are the same in both: `book-set-vs-project` #6,
`book-filter-array` #5, `pouch-turning-hole` #2 (all three worded differently from
their answer, a meaning problem rather than a word problem), and `kw-poll-env` #3 in
All uploads (#2 in its own upload).

## The keyword questions

Vector search + rerank already handled them: 4 of the 5 answers came first, and the
fifth (`kw-poll-env`) was at #3. Hybrid search gave the same positions and scores.
`kw-indexstats` wasn't fooled by the book's list of excluded stages in either run,
and the flag that doesn't exist scored 0.551, below the threshold, in both.

## What the LLM gets

The reports show only the top score and the first answer position, so a separate
comparison listed the 10 chunks each search would send to the LLM (All uploads, all
77 questions, no LLM calls):

| The 10 chunks sent to the LLM | Questions |
|---|---|
| The same, in the same order | 59 |
| The same, in a different order | 1 |
| 1 chunk different | 13 |
| 2 or 3 chunks different | 3 |
| 5 chunks different | 1 |

- On average 0.34 of the 10 chunks differ.
- 26 chunks reached hybrid's top 10 but not vector search's: 25 that only keyword
  search found (in 16 questions), and one that vector search had at #49 (approximate
  search can return a slightly different 50 from run to run). All at #4 to #10, never
  in the top 3.
- The biggest differences were questions with no answer at all (`offtopic-css-center`
  5, `offtopic-france` 3, `mongodb-sql` 3): with nothing relevant to find, the
  low-scoring chunks at the bottom vary. The threshold stops all of them, so those
  chunks never reach the LLM.

## The extra chunks

Of the 17 questions whose top 10 differed:

- **10 can't have gained anything:** 7 have no answer in the uploads, and in 3 the
  extra chunk came from an upload other than the one with the answer.
- **7 book questions got an extra chunk from the book itself.** Read one by one, every
  one was unrelated to its question: example data or code that shared a word with it
  (an energy-reading example for the RAM limit question, a `$sortArray` macro
  mentioning "version 5.2+" for the Map-Reduce version questions, kettle product data,
  a `$merge` / `$out` cheatsheet, a list of languages). Rerank scores 0.48 to 0.59, at
  #5 to #10; the answer stayed at #1.
- What they pushed out was mostly marginal too (the title page, unrelated code), but
  in 2 questions it was related: background on streaming vs blocking stages
  (`typo-memory-limit`), and one of the book's examples (`broad-book-examples`, a broad
  question that wants as many as it can get).

The threshold checks only the top chunk, so chunks lower down ride along whatever
their own score: the energy-reading chunk scored 0.565, below 0.58, and went to the
LLM because the answer at #1 scored 0.896.

## Why nothing changed

Keyword search can only help when it brings in a chunk the reranker scores higher
than vector search's candidates. With 360 chunks, vector search's top 50 already held
every answer, so keyword search mostly added chunks that share a word with the
question but don't answer it, and the reranker ranked them low. It would matter where
vector search misses an answer from its top 50: a much larger library, or codes and
names that vector search handles badly.

## Cost and speed

- **Tokens** (estimate): the merged list held 67 to 96 chunks (average 82) instead of
  vector search's 50, so about 1.6 times the rerank tokens: about 33,000 per search
  instead of 20,000, and about 7 million for a full run of the test questions.
  `rerank-3` costs $0.05 per million tokens after a one-time allowance of 200 million
  free tokens per organization. Keyword search itself uses no tokens.
- **Time:** the two searches inside `$rankFusion` run one after the other. Without
  reranking, a hybrid query took 0.4 to 1.2 s; one reranked hybrid search in All
  uploads took about 2.5 s from the command line (single measurements).

## What this means for the app

- Answers keep vector search + rerank as the default; the 0.58 threshold serves both
  (one config entry).
- Hybrid search stays in the API (`search: "hybrid"`) and the command-line tools
  (`--search hybrid`), as a showcase of `$rankFusion`, a second Atlas Search index and
  `scoreDetails`, and as a safety net if the library grows.
- The web page offers no hybrid choice: side by side, its chunks would almost always
  match vector search's. The page compares answers with and without reranking, where
  the chunks change a lot (see [RERANKING.md](RERANKING.md)).

## Limits

- One small library (360 chunks, one large book) and 77 questions, only 6 of them
  about exact identifiers. A larger library, or more code-heavy uploads, may give
  keyword search something to add.
- No answer run (LLM) was made with hybrid search: the default doesn't change, and the
  chunks sent to the LLM barely differ.
- The comparison of the 10 chunks covered All uploads only; in one upload, the lists
  hold every chunk of a small upload anyway.
- Equal weights for the two searches, and one-letter typo tolerance; other settings
  weren't tried, since reranking decides the order either way.

## Sources

- Vector search + rerank: [results/2026-10-21-vector-rerank.md](results/2026-10-21-vector-rerank.md)
- Hybrid search + rerank: [results/2026-10-21-hybrid.md](results/2026-10-21-hybrid.md)
- The comparison of the 10 chunks and the 7 book cases: one-off scripts, not kept in
  the repository; their results are in this file.
- Atlas documentation: `$rankFusion`
  (https://www.mongodb.com/docs/manual/reference/operator/aggregation/rankFusion/),
  hybrid search (https://www.mongodb.com/docs/vector-search/hybrid-search/), and the
  hybrid search tutorial
  (https://www.mongodb.com/docs/vector-search/hybrid-search/vector-search-with-full-text-search/)
