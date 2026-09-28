# Architecture

A map of the code: what each folder and file is for, and how they fit together.
Details live in each file's header comment; decisions and reasons live in
PROJECT_PLAN.md. Keep this map short. It is updated at the end of each milestone,
so during one it may lag behind the files.

## How it works

```
file ──► extractor ──► splitter ──► chunks collection ──► Atlas Auto-Embedding
         (sections)    (chunks)     (text + metadata)     (vectors, in the vector index)

question ──► search ──► top chunks + scores ──► (milestone 5) threshold check ──► LLM answer
             (Atlas embeds the question with the same model)
```

The app never creates vectors: it stores chunk text, and Atlas embeds it in the
background through the vector search index. New chunks become searchable a few
seconds after they are saved.

## Folders

Scripts and tools import from `src/`, never the reverse.

### `src/`: app code, used by the app at runtime

| File | Purpose |
|---|---|
| `config.js` | Application settings: collection and index names, search limits, chunk sizes. Secrets go in `.env` instead. |
| `db.js` | Opens the MongoDB connection from `.env` (`MONGODB_URI`, `DB_NAME`). |
| `extractors/index.js` | Picks the extractor for a file by its extension; rejects unsupported types. |
| `extractors/text.js` | Plain text: the whole file is one section. Also decodes file bytes to text. |
| `extractors/markdown.js` | Markdown: each heading starts a section, named by its heading path; the first `#` heading is the title. |
| `splitter.js` | Splits sections into overlapping chunks (paragraphs → sentences → lines → words); each chunk starts with its section name. |
| `ingest.js` | Saves an upload and its chunks, all or nothing (`processing` → `complete`); rejects duplicate file names. |
| `search.js` | Vector search for a question: exact within one upload, approximate across all complete uploads. Returns chunks with scores. |

Later: the answer function (milestone 5), `server.js` and routes (milestone 7), the
web page (milestone 8).

### `scripts/`: needed to make the app work

Setup, and the user-facing command-line commands until the web page exists.

| File | Command | Purpose |
|---|---|---|
| `setup-db.js` | `npm run setup` | Creates the collections, regular indexes and vector index. Skips ones that exist. |
| `ingest-file.js` | `npm run ingest -- <file>` | Uploads a file from the command line. |

Later: the ask command (milestone 5).

### `tools/`: maintenance and testing, not needed for the app to work

Everything that shows the app's internals.

| File | Command | Purpose |
|---|---|---|
| `check-db.js` | `npm run check-db` | Connection check and MDB doc counts per collection. |
| `index-status.js` | `npm run index-status` | Search index build status. |
| `probe.js` | `npm run probe -- <fileName>` | How many of an upload's chunks are searchable, and how long since upload. |
| `chunk-file.js` | `npm run chunk -- <file>` | Chunking preview, no database. |
| `search.js` | `npm run search -- "<question>"` | Raw search results with scores, for testing and tuning. |
| `cleanup.js` | `npm run cleanup` | Removes orphan chunks, stale ingests, or one named upload. Lists first; `--yes` removes. |

Later: the `test-questions.json` runner (milestone 4).

### `samples/`: test files to upload

Small files on unrelated topics (the fictional Nimbus CLI, MongoDB's document model,
Claude Code), in both `.md` and `.txt`, so searches across all uploads have
distractors. Written as test data, not as reference material.

## Root files

| File | Purpose |
|---|---|
| `PROJECT_PLAN.md` | What we're building, milestones, decisions, findings, current status. |
| `CLAUDE.md` | Working preferences for Claude Code. |
| `ARCHITECTURE.md` | This map. |
| `.env` | Secrets and per-machine values. Never committed. |
| `.env.example` | The variables `.env` needs, with placeholder values. Committed. |
