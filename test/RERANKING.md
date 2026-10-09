# Reranking vs vector search alone

What adding Voyage AI reranking (`$rerank`, model `rerank-3`) changed compared with
Atlas Vector Search alone, measured on this project's test questions in milestone 9
(runs of 2026-10-09, MongoDB 9.0 on an M10 cluster). Every number comes from the
saved reports listed under Sources, unless it's marked as an estimate.

## In short

- **Better ranking.** The chunk with the answer is now first for 40 of 43 questions
  (vector search alone: 33 in All uploads, 36 in one upload), and the expected upload
  is first for all 50 answerable questions (was 48).
- **Scores that separate answers from non-answers.** Cosine scores put unrelated and
  relevant chunks close together; rerank scores spread them apart. Only 2 unanswerable
  questions now score as high as the lowest real answer (was 16).
- **A threshold that does real work.** At 0.58 on rerank scores, every wrong-upload,
  off-topic and several-uploads-without-the-answer search is stopped before the LLM,
  plus 10 of 12 near-misses. With cosine scores at 0.62, nearly all of them went to
  the LLM, which had to reply "not found" itself.
- **Cheap.** About 20,000 tokens and 300 ms per question (estimates), from a free
  allowance of 200 million tokens.

## How each one scores

**Vector search** turns the question and each chunk into a vector separately (Voyage
AI `voyage-4`, through Atlas Auto-Embedding), then compares the two vectors (cosine
similarity). It measures how close they are in topic, without reading them together.

**The reranker** reads the question and each candidate chunk together and scores how
well that chunk answers that question. It costs more per chunk, so it only rereads the
candidates vector search found.

Both run in one aggregation pipeline (`src/search.js`):

```
$vectorSearch (top 50)  →  $rerank (rerank-3, re-sorts the 50)  →  top 10 to the LLM
```

The threshold check reads the top rerank score; the cosine score is kept next to it
(`vectorScore`) for comparison.

## Test setup

- 7 uploads, 360 chunks: five small samples (Markdown, plain text), a 10-page sewing
  pattern PDF and a 280-page book PDF (313 chunks).
- 71 test questions ([questions.json](questions.json)): 50 answerable (direct, paraphrase, typo,
  mixed-chunk, partial, broad) and 21 not (12 near-misses: on topic, answer absent;
  9 off-topic).
- Each question is searched in All uploads, in its own upload, in a wrong upload
  (answerable ones), and for 11 of them with several uploads ticked together.
- Vector search alone: the baseline run, threshold 0.62 (cosine). Reranked: 50
  candidates, threshold 0.58 (rerank score).

## Results

![Bar chart: share of test questions that come out right per check, vector search alone vs reranked. Ranking: answer first 33 vs 40 of 43 (All uploads), 36 vs 40 (one upload), expected upload first 48 vs 50 of 50. Threshold: answerable questions sent on to the LLM 50 of 50 both; stopped before the LLM: wrong upload 38 vs 50 of 50, near-miss 0 vs 10 of 12, off-topic 3 vs 9 of 9, several uploads without the answer 0 vs 4 of 4.](charts/rerank-before-after.svg)

"Stopped" means the app replies "not found in your uploads" without calling the LLM;
"sent on" means the question passes the threshold and the LLM answers it.

| Check | Vector search alone (0.62) | Reranked (0.58) |
|---|---|---|
| Answer text in the top 10 | 43 of 43 | 43 of 43 |
| Answer text first (All / One) | 33 / 36 of 43 | **40 / 40** |
| Expected upload first (All) | 48 of 50 | **50 of 50** |
| Answerable questions sent on to the LLM | 50 of 50 | 50 of 50 |
| Lowest answerable score | 0.654 | 0.637 |
| Unanswerable questions at or above the lowest answerable score (One) | 16 | **2** |
| Wrong upload stopped by the threshold | 38 of 50 | **50 of 50** |
| Near-misses stopped (All / One) | 0 / 0 of 12 | **10 / 10** |
| Off-topic stopped (All / One) | 0 / 3 of 9 | **9 / 9** |
| Several ticked, one has the answer: sent on to the LLM | 7 of 7 | 7 of 7 |
| Several ticked, none has the answer: stopped | 0 of 4 | **4 of 4** |

In a full test run, questions with no answer in the searched uploads reach the LLM 55
times with vector search alone and 4 times reranked.

## Score scales

![Dot chart: each test question's best score in one upload, vector search alone on the left (cosine) and reranked on the right. With cosine scores, answerable questions (0.65 to 0.90) overlap near-misses, off-topic questions and wrong uploads (0.51 to 0.81) around the 0.62 threshold. Reranked, answerable questions score 0.64 to 0.94, while wrong uploads and off-topic questions fall to 0.24 to 0.51, below the 0.58 threshold; only 2 near-misses stay above it.](charts/rerank-score-spread.svg)

The two panels use different scores (cosine and rerank), so compare where the dots
sit against each panel's own threshold, not across panels.

| Group | Cosine (vector search) | Rerank |
|---|---|---|
| Answerable (One) | 0.654–0.904, median 0.79 | 0.637–0.941, median 0.87 |
| Near-miss | 0.680–0.805 | 0.416–0.734 |
| Off-topic (All) | 0.621–0.795 | 0.279–0.512 |
| Wrong upload | 0.508–0.687, median 0.59 | 0.242–0.387, median 0.26 |

- **Cosine squeezes everything together.** A real answer and a chunk from an
  unrelated upload differ by about 0.2 (medians 0.79 vs 0.59), and the ranges overlap:
  the best wrong-upload chunk (0.687) beats the weakest answer (0.654).
- **The reranker spreads them apart.** The same medians are 0.87 vs 0.26, and the best
  wrong-upload chunk (0.387) is far below the weakest answer (0.637).
- **About 0.25 is the reranker's floor for "no relation".** 21 of the 50 wrong-upload
  searches scored 0.25 or less; 12 landed on exactly 0.2451.
- **Example:** "What hydration should I use for a sourdough loaf?" in All uploads.
  Vector search's best match is the sewing pattern PDF at 0.625, just above the 0.62
  threshold, because both are instructions, so the LLM is called. Reranked, the best
  match scores 0.25 and the question stops at the threshold.
- Rerank scores keep about 3 significant digits (steps of 1/256 above 0.5), so ties
  are common; ties are broken by the cosine score.

## Ranking changes

Where the first chunk holding the answer moved (All uploads; most also in one upload):

| Question | Vector search alone | Reranked |
|---|---|---|
| `pouch-zipper` | #4 | #1 |
| `guide-battery`, `notes-admin-rights` (also upload rank) | #2 | #1 |
| `mongodb-order-lines`, `mongodb-explain` | #2 | #1 |
| `book-blocking-stages`, `book-integral` | #2 | #1 |
| `book-filter-array` (a mostly-code page) | #10 | #5 |
| `book-set-vs-project` | #2 | #5 (still in the top 10, still answered) |

## Choosing the threshold

The rerank threshold replaces the cosine 0.62 for reranked answers; the two scales
can't share a number. Rerank thresholds tried on the saved scores:

| Threshold | Answerable sent on to the LLM | Near-misses stopped (All / One) | Wrong upload, off-topic, several without the answer | Margin below the lowest answerable |
|---|---|---|---|---|
| 0.55 | 50 of 50 | 8 / 9 of 12 | all stopped | 0.087 |
| **0.58** | 50 of 50 | 10 / 10 of 12 | all stopped | 0.057 |
| 0.62 | 50 of 50 | 10 / 10 of 12 | all stopped | 0.017 |

0.58 stops as much as 0.62 with three times the margin; at 20 candidates, a real
answer (`broad-book-examples`) scored 0.625, one score step above 0.62. A refused real
answer can't be recovered, while a question let through only costs an LLM call, so
the margin matters more. The two near-misses still above it (`pouch-larger` 0.73,
`book-max-stages` 0.65) are on topic and close to having an answer; the LLM replies
"not found" to both.

## Answers

A targeted answer run (LLM) covered the 7 questions whose top 10 changed most: 19 of
19 question/mode pairs passed, with 14 LLM calls (about $0.22).

- The answers that moved down or sat lowest (`book-set-vs-project`,
  `partial-memory-limit-price`, `broad-book-examples`) were answered with correct
  citations; the partial one named the part the uploads don't cover.
- **A broad question got better.** "What kinds of example pipelines does the book
  include?" used to stay incomplete at any number of chunks; reranked, it found the
  book's list of example chapters (page 280) and named about a dozen.
- Both near-misses above the threshold got "not found" from the LLM.

## Cost and speed

- **Tokens** (estimate): the question once per candidate plus every candidate's text,
  about 20,000 tokens per search at 50 candidates, about 4 million for a full run of
  the test questions. `rerank-3` costs $0.05 per million tokens after a one-time
  allowance of 200 million free tokens per organization.
- **Time:** one All-uploads search took 505 ms with vector search alone and 813 ms
  reranked (one measurement). A full run of the test questions (about 200 searches)
  took about 2.5 minutes, with no errors or rate limits.
- **LLM calls saved:** fewer unanswerable questions reach the LLM (55 → 4 per full
  test run), which costs far more per call than reranking.
- 20 and 50 candidates gave practically the same results here; 50 leaves room for
  large uploads, where vector search may rank an answer lower.

## Limits

- The test set is small: one large upload, 71 questions. With many more uploads,
  off-topic questions find closer matches, so the threshold should be rechecked.
- Reranking only re-sorts what vector search found: an answer outside the top 50
  candidates never reaches the reranker.
- No full answer run was made with reranking (the last one, vector only, passed 203
  of 203); the targeted run covers the answers it changed most.
- `rerank-3` is in Preview, so its scores may change; reports record the model.
- Both the question's embedding and reranking run at Voyage AI, so neither works
  without it (there's no fallback, and none would help).

## Sources

The charts (`charts/*.svg`) are drawn from the first and fourth reports below.

- Vector search alone: [results/2026-10-09-m10-baseline.md](results/2026-10-09-m10-baseline.md)
- Reranked, 20 and 50 candidates: [results/2026-10-09-rerank-20.md](results/2026-10-09-rerank-20.md),
  [results/2026-10-09-rerank-50.md](results/2026-10-09-rerank-50.md)
- Reranked, final settings: [results/2026-10-09-rerank-reference.md](results/2026-10-09-rerank-reference.md)
- Targeted answer run: [results/2026-10-09-answers-rerank-targeted.md](results/2026-10-09-answers-rerank-targeted.md)
- Atlas documentation: the `$rerank` stage
  (https://www.mongodb.com/docs/vector-search/query/aggregation-stages/rerank/) and
  Native Reranking billing
  (https://www.mongodb.com/docs/vector-search/query/native-reranking/billing/)
