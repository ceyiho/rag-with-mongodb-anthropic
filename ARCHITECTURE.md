# Architecture

A map of the code: what each folder and file is for, and how they fit together.
Details live in each file's header comment; decisions and reasons live in
PROJECT_PLAN.md. Keep this map short. It is updated at the end of each milestone,
so during one it may lag behind the files.

## How it works

```
file ──► extractor ──► splitter ──► chunks collection ──► Atlas Auto-Embedding
         (sections)    (chunks)     (text + metadata)     (vectors, in the vector index)

question ──► search ──► top chunks + scores ──► threshold check ──► LLM answer with citations
             (Atlas embeds the question        (below it: "not found",
              with the same model)              no LLM call)
```

The app never creates vectors: it stores chunk text, and Atlas embeds it in the
background through the vector search index. New chunks become searchable a few
seconds after they are saved.

The LLM (Claude, through the Anthropic API) gets the top chunks as search results and
cites the ones it uses; each citation maps back to an upload and section. A reply with
no citations counts as "not found in your uploads".

## Call chains

Where each part of the app starts, and which `src/` files it calls, in order.

```
npm run ask            → scripts/ask.js → src/answer.js → src/search.js
npm run ingest         → scripts/ingest-file.js → src/ingest.js → src/extractors/ + src/splitter.js
npm run setup          → scripts/setup-db.js
npm run search         → tools/search.js → src/search.js
npm run test-questions → tools/run-test-questions.js → src/search.js
npm run test-answers   → tools/run-test-answers.js → src/answer.js → src/search.js
npm run chunk          → tools/chunk-file.js → src/extractors/ + src/splitter.js  (no database)
npm run cleanup        → tools/cleanup.js → src/ingest.js (removeUploads)
npm run check-db       → tools/check-db.js
npm run index-status   → tools/index-status.js
npm run probe          → tools/probe.js
```

Inside `src/extractors/`:
- `index.js` picks `text.js`, `markdown.js` or `pdf.js` by file extension.
- `markdown.js` reuses the decoder in `text.js`.
- `index.js` and `pdf.js` share `title.js`.

Left out of the chains:
- `src/db.js`: each starting file opens the connection with it and passes it down;
  `src/` modules never open their own.
- `src/config.js`: read almost everywhere.

## Folders

Scripts and tools import from `src/`, never the reverse.

### `src/`: app code, used by the app at runtime

| File | Purpose |
|---|---|
| `config.js` | Application settings: collection and index names, search limits, "not found" thresholds, answer model, scanned-PDF threshold, chunk sizes. Secrets go in `.env` instead. |
| `db.js` | Opens the MongoDB connection from `.env` (`MONGODB_URI`, `DB_NAME`). |
| `extractors/index.js` | Picks the extractor for a file by its extension; rejects unsupported types. |
| `extractors/text.js` | Plain text: the whole file is one section; its chunks start with a title made from the file name. Also decodes file bytes to text. |
| `extractors/markdown.js` | Markdown: each heading starts a section, named by its heading path; the first `#` heading is the title. |
| `extractors/pdf.js` | PDF (text-based, via `unpdf`): each page is a section ("page 12"), read in visual order (code blocks back in place, columns kept apart); drops running headers, footers and page numbers, takes chapter names from the headers for the prefix ("Title > Chapter"), repairs sentences cut by a page break, rejects scanned PDFs. |
| `extractors/title.js` | Makes a title from a file name, for files without one. |
| `splitter.js` | Splits sections into overlapping chunks (paragraphs → sentences → lines → words); each chunk starts with its section name, or the section's prefix if the extractor gives one (plain text: the title; PDFs: the title, and the chapter if found). |
| `ingest.js` | Saves an upload and its chunks, all or nothing (`processing` → `complete`); rejects duplicate file names. |
| `search.js` | Vector search for a question: exact within one upload, approximate across all complete uploads. Returns chunks with scores. |
| `answer.js` | Answers a question: search, then the "not found" threshold check, then the LLM with citations. Holds the system prompt. |

Later: `server.js` and routes (milestone 7; planned in API_SPEC.md), the web page in
`public/` (milestone 8).

### `scripts/`: needed to make the app work

Setup, and the user-facing command-line commands until the web page exists.

| File | Command | Purpose |
|---|---|---|
| `setup-db.js` | `npm run setup` | Creates the collections, regular indexes and vector index. Skips ones that exist. |
| `ingest-file.js` | `npm run ingest -- <file>` | Uploads a file from the command line. |
| `ask.js` | `npm run ask -- "<question>" [--upload <fileName>]` | Asks a question from the command line; prints the answer and its sources. |

### `tools/`: maintenance and testing, not needed for the app to work

Everything that shows the app's internals.

| File | Command | Purpose |
|---|---|---|
| `check-db.js` | `npm run check-db` | Connection check and MDB doc counts per collection. |
| `index-status.js` | `npm run index-status` | Search index build status. |
| `probe.js` | `npm run probe -- <fileName>` | How many of an upload's chunks are searchable, and how long since upload. |
| `chunk-file.js` | `npm run chunk -- <file> [--full]` | Chunking preview, no database: each chunk's start and end on one line, with the PDF prefix; `--full` prints whole chunks. |
| `search.js` | `npm run search -- "<question>"` | Raw search results with scores, for testing and tuning. |
| `run-test-questions.js` | `npm run test-questions` | Runs `test/questions.json` through search only: scores, ranks, whether the answer text was retrieved, and what the threshold does. `--save <label>` writes a report to `test/results/`. Its header describes the question fields and kinds. |
| `run-test-answers.js` | `npm run test-answers` | Runs `test/questions.json` through the answer function (calls the LLM): Pass/Fail per reply, with a diagnosis for each Fail. `--save <label>` writes a report with every answer; `--only <ids>` runs a few questions; `--limit <n>` sends n chunks to the LLM instead of `config.js`'s. |
| `cleanup.js` | `npm run cleanup` | Removes orphan chunks, stale ingests, or one named upload. Lists first; `--yes` removes. |

### `test/`: test questions and saved test runs

`questions.json` holds the test questions against the samples: which upload should
answer each, the answer phrases, and a wrong upload for each answerable one. Fields and
kinds are described in `tools/run-test-questions.js`.

`results/` holds one Markdown report per saved run: `npm run test-questions -- --save <label>` writes
`<date>-<label>.md` (search scores), and `npm run test-answers -- --save <label>` writes
`<date>-answers-<label>.md` (answers, with the system prompt used). Each report lists
the settings that affect its results. Findings in PROJECT_PLAN.md name the date of the
runs they rely on.

### `samples/`: test files to upload

Small files on unrelated topics (the fictional Nimbus CLI, MongoDB's document model,
Claude Code), in both `.md` and `.txt`, so searches across all uploads have
distractors. Written as test data, not as reference material.

`samples/private-samples/` holds real files for testing, such as PDFs of books. It's
gitignored, since they may be copyrighted.

`samples/pdf-mocks/` holds small made-up PDFs for layouts the real ones lack: running
headers and footers (fixed, numbered, chapter names, book-style alternating, two
columns, a repeated body heading that must stay) and scanned pages (rejected, or
skipped in a text PDF). Check them with `npm run chunk -- <file>`. They are generated
by a script kept outside the repository, whose header lists each mock's expected
result.

### `wireframe/`: static mock-up of the web page

`index.html`: one self-contained page with fake data and no backend, opened straight
from disk. A state menu at the top switches between answers, "not found", errors,
uploads and rejections, title search, and an empty library; each state names the API
route behind it. Milestone 8 builds the real page from it. Not part of the app.

## Root files

| File | Purpose |
|---|---|
| `PROJECT_PLAN.md` | What we're building, milestones, decisions, findings, current status. |
| `CLAUDE.md` | Working preferences for Claude Code. Local only (gitignored). |
| `ARCHITECTURE.md` | This map. |
| `API_SPEC.md` | The API's routes, request and response formats, and error codes, and how the web page uses them (milestones 7–8). |
| `HANDOFF.md` | Short-lived notes for the next session, updated at each handoff. Local only (gitignored). |
| `.env` | Secrets and per-machine values. Never committed. |
| `.env.example` | The variables `.env` needs, with placeholder values. Committed. |
