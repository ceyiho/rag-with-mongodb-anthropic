// Turns API data into safe HTML for the page. Upload titles and excerpts, and the
// LLM's answers, are untrusted text, so everything is escaped before it's shown
// (docs/API_SPEC.md: Questions, Formatting).

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Text made safe to put inside HTML, including inside attribute values.
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

// ---------- Answers ----------

// Placeholders for citation markers, from Unicode's private use area: escaping and
// Markdown leave them alone, and any already in the answer are removed first, so a
// placeholder always comes from a citation.
const MARK_OPEN = String.fromCharCode(0xe000);
const MARK_CLOSE = String.fromCharCode(0xe001);
const MARKER = new RegExp(`${MARK_OPEN}([0-9]+)${MARK_CLOSE}`, 'g');
// The same kind of placeholder for `code` spans while a line looks for **bold** (see
// inlineHtml). Removed from the answer first too.
const CODE_OPEN = String.fromCharCode(0xe002);
const CODE_CLOSE = String.fromCharCode(0xe003);
const CODE_SPAN = new RegExp(`${CODE_OPEN}([0-9]+)${CODE_CLOSE}`, 'g');
const STRAY_MARKS = new RegExp(`[${MARK_OPEN}${MARK_CLOSE}${CODE_OPEN}${CODE_CLOSE}]`, 'g');

// The answer's parts as HTML (docs/API_SPEC.md: Formatting). A Markdown list can be cut
// across several parts, so the parts are joined into one text with a placeholder where
// each citation marker goes. Then everything is escaped, a small set of Markdown is
// turned into formatting, and the placeholders become marker buttons. The page never
// reads "[1]" out of the text, so a literal "[1]" in an upload can't confuse it.
export function answerHtml(parts) {
  const text = parts.map(({ text, cites }) => {
    const clean = text.replace(STRAY_MARKS, '');
    const body = clean.trimEnd();   // the marker goes before a trailing line break
    const markers = cites.map((n) => `${MARK_OPEN}${n}${MARK_CLOSE}`).join('');
    return body + markers + clean.slice(body.length);
  }).join('');
  return markdownHtml(escapeHtml(text)).replace(MARKER,
    (_, n) => `<button class="cite" data-n="${n}" aria-label="Source ${n}">${n}</button>`);
}

// A list item: "- ", "* " or "+ " for bullets, "1. " or "1) " for numbers. Its
// indentation sets how deeply it is nested.
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

// The start or end of a fenced code block: three backticks, optionally indented (a
// block inside a list item) and, on the opening line, followed by a language name.
const FENCE = /^(\s*)```/;

// The Markdown the LLM writes, as HTML: paragraphs, bullet and numbered lists (nested
// by indentation), fenced code blocks, `code`, **bold** and *italic*. Anything else
// (headings, links, tables) stays as plain text: none of it appeared in about 1,000
// saved answers (test/results/, checked 2026-10-28). Takes text that is already escaped.
function markdownHtml(text) {
  const out = [];
  let paragraph = [];   // lines of the paragraph being read; a line break inside one stays
  const lists = [];     // the lists open around the current line, innermost last
  let code = null;      // inside a fenced code block: { indent, lines }

  const endParagraph = () => {
    if (paragraph.length) out.push(`<p>${paragraph.join('<br>')}</p>`);
    paragraph = [];
  };
  const closeList = () => out.push(`</li></${lists.pop().tag}>`);
  // Code lines are kept as written (only the fence's own indentation is removed), with
  // no Markdown inside. The language name isn't used: no syntax colouring.
  const endCode = () => {
    out.push(`<pre class="codeblock"><code>${code.lines.join('\n')}</code></pre>`);
    code = null;
  };

  for (const line of text.split('\n')) {
    if (code) {
      if (FENCE.test(line)) {
        endCode();
        // A citation marker placed after the closing fence (the part ended there).
        const after = line.trim().slice(3).trim();
        if (after) out.push(`<p>${inlineHtml(after)}</p>`);
      } else {
        code.lines.push(line.startsWith(code.indent) ? line.slice(code.indent.length) : line.trimStart());
      }
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      endParagraph();
      // An indented block belongs to the open list item; one at the margin ends the list.
      if (!fence[1]) while (lists.length) closeList();
      code = { indent: fence[1], lines: [] };
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      endParagraph();
      const indent = item[1].length;
      const tag = /\d/.test(item[2]) ? 'ol' : 'ul';
      while (lists.length && lists.at(-1).indent > indent) closeList();
      if (lists.length && lists.at(-1).indent === indent && lists.at(-1).tag !== tag) closeList();
      if (lists.length && lists.at(-1).indent === indent) {
        out.push('</li><li>');
      } else {
        // A new list, nested in the open item if it is indented further.
        const start = tag === 'ol' ? parseInt(item[2], 10) : 1;
        lists.push({ tag, indent });
        out.push(`<${tag}${start === 1 ? '' : ` start="${start}"`}><li>`);
      }
      out.push(inlineHtml(item[3]));
    } else if (!line.trim()) {
      endParagraph();   // a blank line ends a paragraph; a list may go on after it
    } else if (lists.length && /^\s/.test(line)) {
      out.push(`<br>${inlineHtml(line.trim())}`);   // more text of the open list item
    } else {
      while (lists.length) closeList();
      paragraph.push(inlineHtml(line.trim()));
    }
  }
  if (code) endCode();   // a block the answer never closed
  endParagraph();
  while (lists.length) closeList();
  return out.join('');
}

// `code`, **bold**, *italic* and ***both*** in one line of escaped text. Code spans are
// set aside as placeholders first, so bold can contain code ("**Use `$map`.**") while
// "**" inside code stays as written; then they go back in. Italics need text right
// inside the stars and no word character right outside them, so "2 * 3" and "a*b"
// stay as they are. Not _italic_: underscores start MongoDB names like _id.
function inlineHtml(text) {
  const codes = [];
  return text
    .replace(/`([^`]+)`/g, (_, code) => `${CODE_OPEN}${codes.push(code) - 1}${CODE_CLOSE}`)
    .replace(/\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\s](?:[^*]*[^*\s])?)\*(?![\w*])/g, '$1<em>$2</em>')
    .replace(CODE_SPAN, (_, i) => `<code>${codes[i]}</code>`);
}

// Where a citation or a search hit points, as shown on the page (docs/API_SPEC.md: where a
// citation points): "PDF p. 12", "Installation › Windows", "passage 2 of 7", or
// "Opening text" for Markdown text before the first heading below the title (its
// section is null). Null only for a PDF passage without a page, which ingest never
// stores.
export function locationLabel(item) {
  if (item.fileType === 'pdf') return item.page ? `PDF p. ${item.page}` : null;
  if (item.fileType === 'txt') return `passage ${item.chunkIndex + 1} of ${item.chunkCount}`;
  return item.section ? item.section.split(' > ').join(' › ') : 'Opening text';
}

// When something happened, for answers: "just now", "12 min ago", "3 h ago", then the
// date ("3 Oct", with the year if it isn't this year's).
export function timeAgo(time, now = Date.now()) {
  const minutes = Math.floor((now - time) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  const date = new Date(time);
  const year = date.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year });
}

// ---------- Title search ----------

// Text as HTML, with the first word start matching each of `words` marked (<mark>),
// for title search suggestions. Words start at the beginning or after a space, hyphen,
// underscore or dot, as the server splits them. Matches are found in the plain text
// and each piece is escaped afterwards, so a mark can never land inside an escape like
// "&amp;". A match the server made with a typo has no exact text, so it isn't marked.
export function markWordStarts(text, words) {
  const lower = text.toLowerCase();
  const ranges = [];
  for (const word of words) {
    for (let i = 0; i < lower.length; i++) {
      if ((i === 0 || /[\s\-_.]/.test(lower[i - 1])) && lower.startsWith(word, i)) {
        ranges.push([i, i + word.length]);
        break;
      }
    }
  }
  // By start, the longest first, so "nimbus" wins over "nim" at the same place.
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let html = '';
  let at = 0;
  for (const [start, end] of ranges) {
    if (start < at) continue;   // overlaps a mark already made
    html += `${escapeHtml(text.slice(at, start))}<mark>${escapeHtml(text.slice(start, end))}</mark>`;
    at = end;
  }
  return html + escapeHtml(text.slice(at));
}
