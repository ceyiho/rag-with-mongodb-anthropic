// Turns API data into safe HTML for the page. Upload titles and excerpts, and the
// LLM's answers, are untrusted text, so everything is escaped before it's shown
// (API_SPEC.md: Questions, Formatting).

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Text made safe to put inside HTML, including inside attribute values.
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}
