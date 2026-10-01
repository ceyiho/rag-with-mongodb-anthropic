// PDF (text-based): each page is a section, named by its PDF page number ("page 12",
// as a PDF viewer counts, not the number printed on the page). Pages with no text
// (covers, full-page pictures) give no section. The title comes from the PDF's
// metadata, or null if it has none (or only a placeholder like "Untitled").
// Chunks start with the title (from the file name if there is none) instead of
// "page 12", which says nothing about the content; the section stays "page 12" for
// citations.
//
// Cleanup before splitting into sections:
// - A page's first or last line is dropped if it is only a page number ("6", "vi",
//   "Page 6", "6 of 20").
// - A sentence cut by a page break is repaired: if a page doesn't end in . ! ? and
//   the text clearly continues (the next page starts in lowercase, or this page ends
//   with a comma or a word like "the" or "of"), the page's unfinished end moves to
//   the start of the next page. Not when the page's last line looks like code (code
//   has no sentence ends, so whole code blocks would move, page after page), and not
//   when the unfinished end is longer than MAX_MOVE (then it isn't one cut sentence).
//
// Scanned PDFs (images of pages, no text layer) are rejected: too few characters per
// page on average (config.pdf.minAverageChars). The average is over the whole file,
// so a few empty pages in a text PDF are fine.

const { getDocumentProxy, extractText, getMeta } = require('unpdf');
const config = require('../config');
const { titleFromFileName } = require('./title');

const PAGE_NUMBER = /^\s*(page\s+)?(\d+|[ivxlc]{1,7})(\s+of\s+\d+)?\s*$/i;
const ENDS_SENTENCE = /[.!?]["')\]”’]*$/;
const SENTENCE_END = /[.!?]["')\]”’]*\s+/g;
const CODE = /[{}[\];]|":/;   // braces, brackets, semicolons, JSON keys
const MAX_MOVE = 400;         // characters; the longest real cut sentence seen was 294
const PLACEHOLDER_TITLE = /^(untitled|microsoft word - .*|.*\.(pdf|docx?|odt|pages|txt))$/i;

// Words a sentence can't end with: a page ending in one continues on the next page.
const CONTINUING_WORDS = new Set([
  'a', 'an', 'the', 'this', 'these', 'that', 'its', 'their', 'our', 'your', 'and', 'or',
  'but', 'nor', 'of', 'by', 'to', 'in', 'on', 'at', 'for', 'from', 'with', 'into',
  'as', 'than', 'which', 'who', 'is', 'are', 'was', 'were', 'be',
]);

// Reads the PDF's title and text per page, rejects it if it looks scanned, cleans up
// the pages and returns one section per page that has text.
async function extract(buffer, fileName) {
  let pdf;
  try {
    // verbosity 0: pdf.js logs errors only, not its warnings about damaged files.
    pdf = await getDocumentProxy(new Uint8Array(buffer), { verbosity: 0 });
  } catch (err) {
    throw new Error(`Can't read this PDF (${err.message}).`);
  }

  try {
    const { info } = await getMeta(pdf);
    const { totalPages, text } = await extractText(pdf, { mergePages: false });

    const pages = text.map(stripPageNumber);
    const totalChars = pages.reduce((sum, page) => sum + page.length, 0);
    const average = Math.round(totalChars / totalPages);
    if (average < config.pdf.minAverageChars) {
      throw new Error(`This PDF has almost no text (${average} characters per page on average). `
        + 'It looks scanned or made of images; only text-based PDFs are supported.');
    }

    repairCutSentences(pages);
    const title = titleFromMeta(info);
    const prefix = title || titleFromFileName(fileName);
    const sections = pages
      .map((page, i) => ({ section: `page ${i + 1}`, text: page, prefix }))
      .filter(({ text }) => text);

    return { title, sections };
  } finally {
    await pdf.loadingTask.destroy();   // frees pdf.js memory for this file
  }
}

// Drops a page's first or last line if it is only a page number ("6", "vi", "Page 6",
// "6 of 20"), so the number doesn't end up in a chunk.
function stripPageNumber(text) {
  const lines = text.trim().split('\n');
  if (lines.length && PAGE_NUMBER.test(lines[lines.length - 1])) lines.pop();
  if (lines.length && PAGE_NUMBER.test(lines[0])) lines.shift();
  return lines.join('\n').trim();
}

// Moves each page's unfinished last sentence to the start of the next page, when the
// text clearly continues there and the page doesn't end in code. Changes pages in place.
function repairCutSentences(pages) {
  for (let i = 0; i < pages.length - 1; i++) {
    const page = pages[i];
    const next = pages[i + 1];
    if (!page || !next || ENDS_SENTENCE.test(page) || !continues(page, next)) continue;
    if (CODE.test(page.slice(page.lastIndexOf('\n') + 1))) continue;   // last line

    let cut = 0;   // where the unfinished sentence starts: after the last sentence end
    for (const match of page.matchAll(SENTENCE_END)) cut = match.index + match[0].length;
    if (page.length - cut > MAX_MOVE) continue;
    pages[i] = page.slice(0, cut).trim();
    pages[i + 1] = `${page.slice(cut)}\n${next}`;
  }
}

// True if the text clearly runs on from this page to the next: the next page starts in
// lowercase, or this page ends with a comma or a word a sentence can't end with.
function continues(page, next) {
  if (/^[a-z]/.test(next)) return true;
  if (page.endsWith(',')) return true;
  const lastWord = page.match(/(\w+)$/);
  return Boolean(lastWord && CONTINUING_WORDS.has(lastWord[1].toLowerCase()));
}

// The title from the PDF's metadata, or null if it has none or only a placeholder
// ("Untitled", "Microsoft Word - report.docx", a file name).
function titleFromMeta(info) {
  const title = typeof info?.Title === 'string' ? info.Title.trim() : '';
  return title && !PLACEHOLDER_TITLE.test(title) ? title : null;
}

module.exports = { extract };
