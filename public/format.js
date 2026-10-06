// Turns API data into safe HTML for the page. Upload titles and excerpts, and the
// LLM's answers, are untrusted text, so everything is escaped before it's shown
// (API_SPEC.md: Questions, Formatting).

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Text made safe to put inside HTML, including inside attribute values.
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

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
