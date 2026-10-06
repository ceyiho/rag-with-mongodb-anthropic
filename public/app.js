// The web page (milestone 8): its state, the functions that draw the page from it, and
// the events that change it. Built from wireframe/index-green.html; the routes it
// calls, and how it reacts to their errors, are in API_SPEC.md.
// Pattern: every change updates `state`, then calls render(), which redraws each area
// of the page from state. Simple, and fast enough at this size.

import { listUploads, checkHealth, searchTitles, askQuestion, ApiError, ServerUnreachable } from './api.js';
import { escapeHtml as esc, markWordStarts, answerHtml, locationLabel, timeAgo } from './format.js';

// While the server or the database is unreachable, check again this often.
const RETRY_MS = 5000;

// On the first load, every group of the picker starts open when there are at most this
// many uploads; with more, only the first group does.
const OPEN_ALL_UP_TO = 20;

// The picker's groups, by the first letter of the title (accents ignored).
const GROUPS = [
  { key: '#', label: '0–9 & other' },
  { key: 'AD', label: 'A – D', from: 'A', to: 'D' },
  { key: 'EH', label: 'E – H', from: 'E', to: 'H' },
  { key: 'IL', label: 'I – L', from: 'I', to: 'L' },
  { key: 'MP', label: 'M – P', from: 'M', to: 'P' },
  { key: 'QT', label: 'Q – T', from: 'Q', to: 'T' },
  { key: 'UZ', label: 'U – Z', from: 'U', to: 'Z' },
];

// Line icons for the empty states, drawn in the current text colour.
const icon = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  folder: icon('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  chat: icon('<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/>'),
  tick: icon('<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>'),
  warn: icon('<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.2v.1"/>'),
};

// What the page says when a part is unreachable: the banner under the header, and the
// workspace's message.
const DOWN = {
  server: {
    banner: 'Can\'t reach the server. Is it running (<code>npm start</code>)? The page retries every few seconds.',
    workspace: 'The page can\'t reach the server, so questions can\'t be asked right now.',
  },
  database: {
    banner: 'The server can\'t reach the database. Check Atlas Network Access; your IP address may have changed. The page retries every few seconds.',
    workspace: 'The server can\'t reach the database, so questions can\'t be asked right now.',
  },
};

const state = {
  // 'checking' until the first health check answers, then 'ok', or the part that is
  // unreachable: 'server' or 'database'.
  connection: 'checking',
  uploads: null,          // from GET /api/uploads, sorted by title; null until it arrives
  listFailed: false,      // the list couldn't be loaded although the connection is fine
  open: new Set(),        // keys of the open groups
  // The picker's ticks, in page memory only: every page load starts with nothing ticked.
  all: false,             // "All uploads" ticked
  selected: new Set(),    // ids of the individually ticked uploads
  // The latest question: { question, scope, askedAt, status, reply | error }. status is
  // 'loading', 'done' (reply is the API's answer) or 'error'. scope is { all: true } or
  // { uploads: [{ id, title }] }, kept as asked. Replaced as a whole on every change.
  latest: null,
};

const $ = (id) => document.getElementById(id);
const isDown = () => state.connection === 'server' || state.connection === 'database';
const byId = (id) => state.uploads?.find((u) => u.id === id);
const ready = () => (state.uploads ?? []).filter((u) => u.searchable);
const nothingSelected = () => !state.all && !state.selected.size;
const asking = () => state.latest?.status === 'loading';

// Splitting accents off (NFD) leaves the plain letter first: "É" becomes "E" + accent.
function groupOf(title) {
  const first = title.normalize('NFD').charAt(0).toUpperCase();
  return GROUPS.find((g) => g.from && first >= g.from && first <= g.to)?.key ?? '#';
}

// ---------- Connection and upload list ----------

let healthCheck = null;   // the check in progress, so two failed requests share one
let retryTimer = null;

// Asks GET /api/health which part is reachable, and redraws the dot and the banner.
// While a part is down, it checks again every RETRY_MS. When the connection becomes
// fine (on the first check, or after being down), it loads the upload list, which may
// have changed meanwhile.
function checkConnection() {
  healthCheck ??= (async () => {
    clearTimeout(retryTimer);
    const before = state.connection;
    state.connection = await checkHealth();
    healthCheck = null;
    if (isDown()) retryTimer = setTimeout(checkConnection, RETRY_MS);
    else if (before !== 'ok') await loadUploads();
    render();
  })();
  return healthCheck;
}

// Loads the upload list. If that fails, the health check tells a connection problem
// (the banner) from a failure of the list itself.
async function loadUploads() {
  try {
    const uploads = await listUploads();
    if (!state.uploads) openGroupsAtStart(uploads);
    state.uploads = uploads;
    state.listFailed = false;
    // Ticks only for uploads that are still there and searchable.
    for (const id of state.selected) {
      if (!byId(id)?.searchable) state.selected.delete(id);
    }
    if (!ready().length) state.all = false;
  } catch (err) {
    console.error('Loading the upload list failed:', err);
    await checkConnection();
    state.listFailed = state.connection === 'ok';
  }
  render();
}

function openGroupsAtStart(uploads) {
  const used = GROUPS.filter((g) => uploads.some((u) => groupOf(u.title) === g.key));
  for (const g of uploads.length <= OPEN_ALL_UP_TO ? used : used.slice(0, 1)) state.open.add(g.key);
}

// ---------- Drawing ----------

function render() {
  renderConnection();
  renderAllRow();
  renderTree();
  renderFoot();
  renderScope();
  renderWorkspace();
  renderAsk();
}

function renderConnection() {
  const [dot, label] = state.connection === 'checking' ? ['checking', 'Connecting…']
    : isDown() ? ['down', 'Disconnected']
    : ['', 'Connected'];
  $('connStatus').innerHTML = `<span class="dot ${dot}"></span>${label}`;
  $('banner').innerHTML = DOWN[state.connection]?.banner ?? '';
  $('banner').classList.toggle('show', isDown());
  $('uploadBtn').disabled = isDown();
  $('titleSearch').disabled = isDown();
}

function renderAllRow() {
  const n = ready().length;
  const processing = (state.uploads?.length ?? 0) - n;
  $('allBox').checked = state.all;
  $('allBox').disabled = !n;
  $('allCount').textContent = isDown() || !state.uploads ? '' : `${n}${processing ? ` ready, ${processing} processing` : ''}`;
  $('allRow').style.display = state.uploads?.length || isDown() ? '' : 'none';
}

function renderTree() {
  const tree = $('tree');
  if (isDown()) {
    tree.innerHTML = '<div class="empty-lib">Couldn\'t load uploads.</div>';
    return;
  }
  if (!state.uploads) {
    tree.innerHTML = `<div class="empty-lib">${state.listFailed
      ? 'Couldn\'t load uploads. Reload the page to try again.'
      : 'Loading uploads…'}</div>`;
    return;
  }
  if (!state.uploads.length) {
    tree.innerHTML = `<div class="empty-lib"><div class="big">${ICONS.folder}</div>No uploads yet.<br>Upload a .txt, .md or text-based PDF to start asking questions.</div>`;
    return;
  }

  // The list arrives sorted by title, so each group stays sorted.
  const groups = Object.fromEntries(GROUPS.map((g) => [g.key, []]));
  for (const u of state.uploads) groups[groupOf(u.title)].push(u);

  tree.innerHTML = GROUPS.map((g) => {
    const items = groups[g.key];
    if (!items.length) {
      return `<button class="bucket-head empty" disabled><span class="chev">▸</span>${g.label}<span class="n">0</span></button>`;
    }
    const open = state.open.has(g.key);
    const nSel = items.filter((u) => state.selected.has(u.id)).length;
    const head = `<button class="bucket-head ${open ? 'open' : ''}" data-group="${g.key}" aria-expanded="${open}">
        <span class="chev">▸</span>${g.label}
        ${nSel ? `<span class="selcount" title="${nSel} selected">${nSel}</span>` : ''}
        <span class="n">${items.length}</span></button>`;
    return open ? `${head}<ul class="items">${items.map(itemRow).join('')}</ul>` : head;
  }).join('');
}

// One upload in the picker. Until it is searchable it can't be ticked.
function itemRow(u) {
  const sel = state.selected.has(u.id);
  const tip = `${u.title}\n${u.fileName}\n${u.searchable ? `${u.chunkCount} chunks` : 'Being indexed for search'}`;
  return `<li class="item ${sel ? 'sel' : ''} ${u.searchable ? '' : 'disabled'}" data-id="${esc(u.id)}" title="${esc(tip)}">
      <input type="checkbox" ${sel ? 'checked' : ''} ${u.searchable ? '' : 'disabled'} tabindex="-1">
      <span class="type ${esc(u.fileType)}">${esc(u.fileType.toUpperCase())}</span>
      <span class="title">${esc(u.title)}</span>
      ${u.searchable ? '' : '<span class="pill processing">processing…</span>'}
    </li>`;
}

function renderFoot() {
  const n = state.selected.size;
  const label = state.all ? 'All uploads selected' : n ? `${n} selected` : 'Nothing selected';
  $('sideFoot').innerHTML = state.uploads?.length && !isDown()
    ? `<span>${label}</span><span class="spacer"></span>
       ${nothingSelected() ? '' : '<button class="linkbtn" id="clearSel">Clear</button>'}
       <button class="linkbtn" id="collapseAll">Collapse all</button>`
    : '';
}

// What the next question will be asked of, as chips that can be removed.
function renderScope() {
  const el = $('scope');
  if (!state.uploads?.length || isDown()) {
    el.innerHTML = '';
  } else if (nothingSelected()) {
    el.innerHTML = 'Asking: <span class="none-sel">nothing selected yet</span>';
  } else if (state.all) {
    el.innerHTML = `Asking: <span class="chip all"><span>All uploads (${ready().length})</span>
      <button data-unselect="all" aria-label="Remove">×</button></span>`;
  } else {
    // In list order, so sorted by title.
    const chips = state.uploads.filter((u) => state.selected.has(u.id)).map((u) =>
      `<span class="chip" title="${esc(u.fileName)}"><span>${esc(u.title)}</span><button data-unselect="${esc(u.id)}" aria-label="Remove">×</button></span>`);
    el.innerHTML = `Asking: ${chips.join('')}`;
  }
}

let shownLatest = null;   // the state.latest whose card is on the page

function renderWorkspace() {
  const el = $('answers');
  if (!isDown() && state.latest) {
    // Redrawn only when the latest question changes (a new state.latest), since a redraw
    // would close the sources and the "How this was found" panel the user opened.
    if (shownLatest !== state.latest) el.innerHTML = answerCard(state.latest);
    shownLatest = state.latest;
    return;
  }
  shownLatest = null;
  if (isDown()) {
    el.innerHTML = `<div class="ws-empty"><div class="big warn">${ICONS.warn}</div>${DOWN[state.connection].workspace}</div>`;
  } else if (!state.uploads) {
    el.innerHTML = '';
  } else if (!state.uploads.length) {
    el.innerHTML = `<div class="ws-empty"><div class="big">${ICONS.chat}</div>Upload a file on the left, then ask questions about it here.<br>Answers come only from your uploads, with sources.</div>`;
  } else if (nothingSelected()) {
    el.innerHTML = `<div class="ws-empty"><div class="big">${ICONS.tick}</div>Choose what to ask about: tick uploads on the left, or All uploads.<br>Answers come only from the uploads you choose, with sources.</div>`;
  } else {
    el.innerHTML = `<div class="ws-empty"><div class="big">${ICONS.chat}</div>Ask a question about your uploads.</div>`;
  }
}

// With nothing ticked the box is greyed and read-only, not disabled: a disabled box
// ignores clicks, and a click should point the user to the picker.
function renderAsk() {
  const q = $('question');
  const off = !isDown() && ready().length > 0 && nothingSelected();
  q.disabled = isDown() || !ready().length;
  q.readOnly = off;
  q.placeholder = off
    ? 'Tick uploads on the left, or All uploads, to ask a question.'
    : 'Ask a question about your uploads…';
  $('askBtn').disabled = q.disabled || off || asking() || !q.value.trim();
  document.querySelector('.ask').classList.toggle('off', off);
  const length = q.value.length;
  $('charCount').textContent = length > 800 ? `${length} / 1000` : '';
}

// The question box grows with its text up to MAX_BOX_PX, then scrolls.
const MAX_BOX_PX = 220;

function grow() {
  const q = $('question');
  q.style.height = 'auto';
  q.style.height = `${Math.min(q.scrollHeight, MAX_BOX_PX)}px`;
  q.style.overflowY = q.scrollHeight > MAX_BOX_PX ? 'auto' : 'hidden';
  renderAsk();
}

// Briefly highlights the picker, when a question can't be asked because nothing is
// ticked.
function nudgePicker() {
  const sidebar = $('sidebar');
  sidebar.classList.remove('nudge');
  void sidebar.offsetWidth;   // restarts the animation on repeated clicks
  sidebar.classList.add('nudge');
}

// ---------- Picker ----------

// Ticks or unticks one upload. Individual ticks and "All uploads" don't mix, so ticking
// one unticks "All uploads". Its group opens, so the tick can be seen.
function toggleUpload(id) {
  const u = byId(id);
  if (!u?.searchable) return;
  state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
  state.all = false;
  state.open.add(groupOf(u.title));
  render();
}

function toggleAll() {
  if (!ready().length) return;
  state.all = !state.all;
  state.selected.clear();
  render();
}

function clearSelection() {
  state.all = false;
  state.selected.clear();
  render();
}

// ---------- Title search ----------
// Suggestions come from GET /api/uploads/search (Atlas Search autocomplete on titles and
// file names, typos allowed, best match first), asked once typing pauses. If the title
// index is missing (503 titleSearchUnavailable) or the request fails, the page filters
// its own list instead.

const SEARCH_DELAY_MS = 200;
const MAX_SUGGESTIONS = 8;

let searchTimer = null;
let searchSeq = 0;          // numbers the requests, so a late reply to an older query is dropped
let suggestions = null;     // { query, uploads, local } for the dropdown; null when there are none
let activeSuggestion = -1;  // the row the arrow keys point at

// Words as the server splits them: at spaces, hyphens, underscores and dots.
function searchWords(text) {
  return text.toLowerCase().split(/[\s\-_.]+/).filter(Boolean);
}

// The typed words that count: one letter matches nothing on the server, so suggestions
// start at two letters, and a one-letter word is skipped while a longer one is there.
function typedWords(query) {
  return searchWords(query).filter((w) => w.length > 1);
}

function onSearchInput() {
  clearTimeout(searchTimer);
  activeSuggestion = -1;
  const query = $('titleSearch').value.trim();
  if (!typedWords(query).length) {
    searchSeq++;   // a reply still on its way is no longer wanted
    suggestions = null;
    renderSuggest();
    return;
  }
  searchTimer = setTimeout(() => runSearch(query), SEARCH_DELAY_MS);
}

async function runSearch(query) {
  const seq = ++searchSeq;
  let uploads;
  let local = false;
  try {
    uploads = await searchTitles(query);
  } catch (err) {
    if (!(err instanceof ApiError && err.code === 'titleSearchUnavailable')) {
      console.error('Title search failed:', err);
      checkConnection();
    }
    uploads = filterLocally(query);
    local = true;
  }
  if (seq !== searchSeq) return;
  suggestions = { query, uploads, local };
  renderSuggest();
}

// The fallback: every typed word must start a word of the title or the file name, as on
// the server, but without typos. In list order (by title).
function filterLocally(query) {
  const typed = typedWords(query);
  return (state.uploads ?? []).filter((u) => {
    const own = searchWords(`${u.title} ${u.fileName}`);
    return typed.every((t) => own.some((w) => w.startsWith(t)));
  }).slice(0, MAX_SUGGESTIONS);
}

function renderSuggest() {
  const box = $('suggest');
  if (!suggestions) {
    box.classList.remove('show');
    return;
  }
  const { query, uploads, local } = suggestions;
  const words = typedWords(query);
  const rows = uploads.map((found, i) => {
    const u = byId(found.id) ?? found;   // the page's copy has the latest searchable
    return `<div class="row ${i === activeSuggestion ? 'active' : ''}" data-id="${esc(u.id)}">
        <input type="checkbox" ${state.selected.has(u.id) ? 'checked' : ''} ${u.searchable ? '' : 'disabled'} tabindex="-1">
        <div><div class="t">${markWordStarts(u.title, words)}${u.searchable ? '' : ' <span class="pill processing">processing…</span>'}</div>
        <div class="f">${esc(u.fileName)}</div></div></div>`;
  }).join('');
  const source = local
    ? 'Filtered in the browser: title search is unavailable'
    : 'Atlas Search · autocomplete on title and file name';
  box.innerHTML = (rows || `<div class="none">No titles or file names match "${esc(query)}".</div>`)
    + `<div class="foot">${source} · ↑↓ to move, Enter to tick, Esc to close</div>`;
  box.classList.add('show');
}

// Ticks a suggestion in the picker, and flashes its row there. An upload added since
// the list was loaded (e.g. from the command line) needs the list reloaded first.
async function pickSuggestion(id) {
  if (!byId(id)) await loadUploads();
  if (!byId(id)?.searchable) return;
  toggleUpload(id);
  const row = document.querySelector(`.item[data-id="${CSS.escape(id)}"]`);
  row?.classList.add('flash');
  row?.scrollIntoView({ block: 'nearest' });
  renderSuggest();
}

// ---------- Questions ----------

// Page wording for the errors POST /api/ask can return (API_SPEC.md: Questions). Any
// other code shows the server's own message.
const ASK_ERRORS = {
  llmUnavailable: 'The answer service is busy right now. Try again in a minute.',
  internal: 'Something went wrong on the server while answering.',
  uploadNotFound: 'One of the ticked uploads no longer exists, so it has been unticked.',
  uploadNotReady: 'One of the ticked uploads is still being processed. Try again once it shows as ready.',
};

// Asks the question in the box (or `question`) of the ticked uploads, or of all uploads
// when `all` is set ("Ask all uploads instead"). One question at a time: Ask stays
// disabled until the reply, so a double click can't cost two LLM calls. A failed
// question stays in the box, for Try again.
async function ask({ question, all = false } = {}) {
  const text = (question ?? $('question').value).trim();
  if (!text || asking() || isDown()) return;
  if (!all && nothingSelected()) {
    nudgePicker();
    return;
  }
  // The titles are kept with the question, so its card can name them later.
  const scope = all || state.all
    ? { all: true }
    : { uploads: state.uploads.filter((u) => state.selected.has(u.id)).map(({ id, title }) => ({ id, title })) };
  state.latest = { question: text, scope, askedAt: Date.now(), status: 'loading' };
  render();
  document.querySelector('.workspace').scrollTo({ top: 0, behavior: 'smooth' });

  try {
    const reply = await askQuestion(text, scope.all ? null : scope.uploads.map((u) => u.id));
    state.latest = { ...state.latest, status: 'done', reply };
    // Cleared only if the box still holds this question, not one typed meanwhile.
    const box = $('question');
    if (box.value.trim() === text) {
      box.value = '';
      grow();
    }
  } catch (err) {
    console.error('Asking failed:', err);
    state.latest = { ...state.latest, status: 'error', error: err };
    if (err instanceof ApiError && ['uploadNotFound', 'uploadNotReady'].includes(err.code)) {
      loadUploads();   // unticks what is gone
    } else if (!(err instanceof ApiError) || (err.status >= 500 && err.code !== 'llmUnavailable')) {
      checkConnection();   // the server or the database may be down
    }
  }
  render();
}

function askErrorText(err) {
  if (err instanceof ServerUnreachable) return 'The server couldn\'t be reached.';
  if (err instanceof ApiError) return ASK_ERRORS[err.code] ?? err.message;
  return 'Something went wrong in the page.';   // a bug; the details are in the console
}

// ---------- Answer card ----------

function scopeLabel(scope) {
  if (scope.all) return 'All uploads';
  const titles = scope.uploads.map((u) => u.title);
  return titles.length <= 2 ? titles.join(', ') : `${titles[0]} and ${titles.length - 1} more`;
}

function answerCard(a) {
  const kind = a.status === 'error' ? 'err' : a.status === 'done' && !a.reply.found ? 'notfound' : '';
  return `<div class="card ${kind}"><div class="q">${esc(a.question)}</div>${answerBody(a)}</div>`;
}

// Everything below the question: waiting, failed, not found, or the answer.
function answerBody(a) {
  const askedOf = `Asked of: ${esc(scopeLabel(a.scope))}`;
  if (a.status === 'loading') {
    const what = a.scope.all ? 'all uploads' : plural(a.scope.uploads.length, 'upload');
    return `<div class="meta">${askedOf}</div>
      <div class="loading-row"><div class="spinner"></div>Searching ${what} and writing an answer… usually a few seconds</div>
      <div class="skel" style="width:92%"></div><div class="skel" style="width:78%"></div><div class="skel" style="width:60%"></div>`;
  }
  if (a.status === 'error') {
    const inBox = $('question').value.trim() === a.question ? ' Your question is still in the box above.' : '';
    return `<div class="meta">${askedOf}</div>
      <div class="nf-title"><span class="nf-icon">!</span>Couldn't get an answer</div>
      <div class="err-text">${esc(askErrorText(a.error))}${inBox}</div>
      <div class="card-actions"><button class="btn" data-action="retry">Try again</button></div>`;
  }

  const r = a.reply;
  const meta = `<div class="meta">${askedOf} · ${timeAgo(a.askedAt)}</div>`;
  if (!r.found) {
    // The same message for both reasons; the reason shows in "How this was found".
    const why = r.reason === 'belowThreshold'
      ? `Nothing in ${a.scope.all ? 'your uploads' : 'the selected uploads'} is close to this question.`
      : 'Passages on this topic were found, but none of them answers the question.';
    const askAll = a.scope.all ? '' : '<div class="card-actions"><button class="btn" data-action="askAll">Ask all uploads instead</button></div>';
    return `${meta}<div class="nf-title"><span class="nf-icon">?</span>Not found in your uploads</div>
      <div class="answer">${why}</div>${askAll}${detailsHtml(r.retrieval)}`;
  }

  const sources = r.citations.map((c) => {
    const where = locationLabel(c);
    return `<div class="src" data-src="${c.n}">
      <div class="src-head" data-action="toggleSource"><span class="chev">▸</span><span class="n">${c.n}</span>
        <span class="t">${esc(c.title)}</span>${where ? `<span class="w">· ${esc(where)}</span>` : ''}<span class="f">${esc(c.fileName)}</span></div>
      <div class="excerpt">${esc(c.excerpt)}</div></div>`;
  }).join('');
  return `${meta}<div class="answer">${answerHtml(r.parts)}</div>
    <div class="sources"><h3>Sources</h3>${sources}</div>${detailsHtml(r.retrieval)}`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// The score bar spans these scores; the red line on it marks the threshold.
const SCORE_BAR = { min: 0.45, max: 0.95 };

// "How this was found", collapsed: how the search ran, what the threshold decided,
// whether the LLM cited anything, and the passages sent to it (or that would have
// been), with their scores.
function detailsHtml(r) {
  const pct = (score) => Math.max(0, Math.min(100, ((score - SCORE_BAR.min) / (SCORE_BAR.max - SCORE_BAR.min)) * 100));
  const rows = r.hits.map((h, i) => {
    const where = locationLabel(h);
    return `<tr class="${h.score < r.threshold ? 'low' : ''}"><td class="rank">${i + 1}</td>
      <td class="score">${h.score.toFixed(2)}<span class="scorebar"><span style="width:${pct(h.score)}%"></span><i style="left:${pct(r.threshold)}%"></i></span></td>
      <td>${esc(h.title)}${where ? ` <span class="where">· ${esc(where)}</span>` : ''}</td>
      <td>${h.cited ? `<span class="citedtag">cited [${h.cited}]</span>` : ''}</td></tr>`;
  }).join('');

  const mode = r.mode.charAt(0).toUpperCase() + r.mode.slice(1);
  const passages = plural(r.hits.length, 'passage');
  let verdict;
  if (r.topScore === null) verdict = 'no passages found, so the LLM was not called';
  else if (r.llmCalled) verdict = `best match ${r.topScore.toFixed(3)} ≥ ${r.threshold}, so the top ${passages} went to the LLM`;
  else verdict = `best match ${r.topScore.toFixed(3)} < ${r.threshold}, so the LLM was not called`;
  const cited = r.hits.filter((h) => h.cited).length;
  const answer = !r.llmCalled ? ''
    : `<dt>Answer</dt><dd>${cited ? `cites ${cited} of the ${passages}` : 'no passage cited, so it counts as not found'}</dd>`;

  return `<details class="details"><summary>How this was found</summary><div class="box">
    <dl class="facts">
      <dt>Search</dt><dd>${esc(mode)} vector search over ${plural(r.uploadCount, 'upload')} (${plural(r.chunksSearched, 'chunk')})</dd>
      <dt>Threshold</dt><dd>${verdict}</dd>${answer}
    </dl>
    ${rows ? `<table class="hits">${rows}</table>` : ''}
    <div class="modes">Search mode: Vector. Keyword and Hybrid come with milestone 9.</div>
  </div></details>`;
}

// ---------- Events ----------

$('tree').addEventListener('click', (e) => {
  const head = e.target.closest('.bucket-head[data-group]');
  if (head) {
    const key = head.dataset.group;
    state.open.has(key) ? state.open.delete(key) : state.open.add(key);
    renderTree();
    return;
  }
  const item = e.target.closest('.item');
  if (item) toggleUpload(item.dataset.id);
});

$('allRow').addEventListener('click', toggleAll);

$('sideFoot').addEventListener('click', (e) => {
  if (e.target.id === 'clearSel') clearSelection();
  if (e.target.id === 'collapseAll') {
    state.open.clear();
    renderTree();
  }
});

$('scope').addEventListener('click', (e) => {
  const id = e.target.closest('[data-unselect]')?.dataset.unselect;
  if (id === 'all') clearSelection();
  else if (id) {
    state.selected.delete(id);
    render();
  }
});

// A click on the greyed question box briefly highlights the picker.
document.querySelector('.ask').addEventListener('click', () => {
  if (!isDown() && ready().length && nothingSelected()) nudgePicker();
});

$('question').addEventListener('input', grow);
$('question').addEventListener('keydown', (e) => {
  // Enter asks, Shift+Enter starts a new line. Not while an input method (e.g. for
  // Chinese or Japanese) is still composing a character.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    ask();
  }
});
$('askBtn').addEventListener('click', () => ask());
window.addEventListener('resize', grow);

$('answers').addEventListener('click', (e) => {
  // A citation marker opens and highlights its source, in the same card.
  const cite = e.target.closest('.cite');
  if (cite) {
    const card = cite.closest('.card');
    const src = card.querySelector(`.src[data-src="${cite.dataset.n}"]`);
    card.querySelectorAll('.src.hl').forEach((s) => s.classList.remove('hl'));
    src?.classList.add('open', 'hl');
    src?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return;
  }
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'toggleSource') e.target.closest('.src').classList.toggle('open');
  else if (action === 'retry') ask({ question: state.latest.question });
  else if (action === 'askAll') ask({ question: state.latest.question, all: true });
});

const search = $('titleSearch');
search.addEventListener('input', onSearchInput);
search.addEventListener('focus', renderSuggest);
search.addEventListener('keydown', (e) => {
  const rows = suggestions?.uploads ?? [];
  if (e.key === 'ArrowDown' && rows.length) {
    activeSuggestion = Math.min(rows.length - 1, activeSuggestion + 1);
    renderSuggest();
    e.preventDefault();
  } else if (e.key === 'ArrowUp' && rows.length) {
    activeSuggestion = Math.max(0, activeSuggestion - 1);
    renderSuggest();
    e.preventDefault();
  } else if (e.key === 'Enter' && rows[activeSuggestion]) {
    pickSuggestion(rows[activeSuggestion].id);
    e.preventDefault();
  } else if (e.key === 'Escape') {
    search.value = '';
    onSearchInput();
  }
});
// Clicks inside the dropdown stay there: ticking redraws the rows, so by the time the
// page-wide "click outside closes it" check below ran, the clicked row would no longer
// be in the page and the dropdown would close after every tick. preventDefault keeps
// the focus in the search box, so typing can continue.
$('suggest').addEventListener('mousedown', (e) => {
  e.stopPropagation();
  e.preventDefault();
  const row = e.target.closest('.row');
  if (row) pickSuggestion(row.dataset.id);
});
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.search')) $('suggest').classList.remove('show');
});

// Uploads are shared and can come from the command line, so the list is reloaded when
// the page's tab or window regains focus. While a part is down, the health checks
// reload it instead.
window.addEventListener('focus', () => {
  if (state.connection === 'ok') loadUploads();
});

render();
checkConnection();
