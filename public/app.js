// The web page (milestone 8): its state, the functions that draw the page from it, and
// the events that change it. Built from wireframe/index-green.html; the routes it
// calls, and how it reacts to their errors, are in API_SPEC.md.
// Pattern: every change updates `state`, then calls render(), which redraws each area
// of the page from state. Simple, and fast enough at this size.

import { listUploads, checkHealth, searchTitles, ApiError } from './api.js';
import { escapeHtml as esc, markWordStarts } from './format.js';

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
};

const $ = (id) => document.getElementById(id);
const isDown = () => state.connection === 'server' || state.connection === 'database';
const byId = (id) => state.uploads?.find((u) => u.id === id);
const ready = () => (state.uploads ?? []).filter((u) => u.searchable);
const nothingSelected = () => !state.all && !state.selected.size;

function groupOf(title) {
  const first = title.normalize('NFD').replace(/[̀-ͯ]/g, '').charAt(0).toUpperCase();
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

function renderWorkspace() {
  const el = $('answers');
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
  $('askBtn').disabled = q.disabled || off || !q.value.trim();
  document.querySelector('.ask').classList.toggle('off', off);
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
  if (isDown() || !ready().length || !nothingSelected()) return;
  const sidebar = $('sidebar');
  sidebar.classList.remove('nudge');
  void sidebar.offsetWidth;   // restarts the animation on repeated clicks
  sidebar.classList.add('nudge');
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
