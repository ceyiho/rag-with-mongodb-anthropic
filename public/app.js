// The web page (milestone 8): its state, the functions that draw the page from it, and
// the events that change it. Built from wireframe/index-green.html; the routes it
// calls, and how it reacts to their errors, are in API_SPEC.md.
// Pattern: every change updates `state`, then calls render(), which redraws each area
// of the page from state. Simple, and fast enough at this size.

import { listUploads, checkHealth } from './api.js';
import { escapeHtml as esc } from './format.js';

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
       <button class="linkbtn" id="collapseAll">Collapse all</button>`
    : '';
}

function renderScope() {
  $('scope').innerHTML = state.uploads?.length && !isDown() && nothingSelected()
    ? 'Asking: <span class="none-sel">nothing selected yet</span>'
    : '';
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

// ---------- Events ----------

$('tree').addEventListener('click', (e) => {
  const head = e.target.closest('.bucket-head[data-group]');
  if (!head) return;
  const key = head.dataset.group;
  state.open.has(key) ? state.open.delete(key) : state.open.add(key);
  renderTree();
});

$('sideFoot').addEventListener('click', (e) => {
  if (e.target.id === 'collapseAll') {
    state.open.clear();
    renderTree();
  }
});

// Uploads are shared and can come from the command line, so the list is reloaded when
// the page's tab or window regains focus. While a part is down, the health checks
// reload it instead.
window.addEventListener('focus', () => {
  if (state.connection === 'ok') loadUploads();
});

render();
checkConnection();
