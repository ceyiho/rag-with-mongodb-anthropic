// PDF (text-based): each page is a section, named by its PDF page number ("page 12",
// as a PDF viewer counts, not the number printed on the page). Pages with no text
// (covers, full-page pictures) give no section. The title comes from the PDF's
// metadata, or null if it has none (or only a placeholder like "Untitled").
// Chunks start with the title (from the file name if there is none) instead of
// "page 12", which says nothing about the content; the section stays "page 12" for
// citations.
//
// Reading order: a PDF stores a page's text in any order, and pdf.js returns it as
// stored. Some PDFs store all the prose first and the code blocks after it, so code
// would land at the end of the page. A page's text is rebuilt from its lines: where the
// stored order jumps back up the page, the text from there (a block) is either
// - merged into the text before it, line by line from top to bottom, if that text is in
//   the same column: at the heights the block covers, every line before it overlaps it
//   left to right, or there is none (the block fills a gap, like code between
//   paragraphs);
// - or kept after it, if they sit side by side: columns, or table cells.
// A page with no jump comes out exactly as pdf.js returns it.
//
// Cleanup before splitting into sections:
// - A page's first or last line is dropped if it is only a page number ("6", "vi",
//   "Page 6", "6 of 20").
// - A sentence cut by a page break is repaired: if a page doesn't end in . ! ? and
//   the text clearly continues (the next page starts in lowercase, or this page ends
//   with a comma or a word like "the" or "of"), the page's unfinished end moves to
//   the start of the next page. Not when the page's last line looks like code (code
//   has no sentence ends, so whole code blocks would move, page after page), nor the
//   next page's first line (code often starts in lowercase, like "var x"), and not
//   when the unfinished end is longer than MAX_MOVE (then it isn't one cut sentence).
//
// Scanned PDFs (images of pages, no text layer) are rejected: too few characters per
// page on average (config.pdf.minAverageChars). The average is over the whole file,
// so a few empty pages in a text PDF are fine.

const { getDocumentProxy, extractTextItems, getMeta } = require('unpdf');
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
    const { totalPages, items } = await extractTextItems(pdf);

    const pages = items.map((pageItems) => stripPageNumber(pageText(pageItems)));
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

// A page's text in reading order (see the header). Items are pdf.js text pieces, in
// stored order, with their position (x from the left, y up from the bottom) and size.
function pageText(items) {
  const groups = [];   // each a list of lines; groups follow each other in stored order
  for (const block of blocks(lines(items))) {
    const last = groups[groups.length - 1];
    if (last && sameColumn(last, block)) {
      const merged = [...last, ...block].sort((a, b) => b.y - a.y);   // top to bottom
      groups[groups.length - 1] = merged.map(endLine);
    } else {
      groups.push(block);
    }
  }
  return groups.map((group, i) => {
    // Only a merged or following group needs a line end before it; the stored text
    // runs on otherwise (a page with no jump is joined exactly as pdf.js returns it).
    const text = group.map((line) => line.text).join('');
    return i > 0 && !groups[i - 1].at(-1).text.endsWith('\n') ? `\n${text}` : text;
  }).join('');
}

// Joins the items into lines (pdf.js marks each line's last item with hasEOL). A line's
// y is its first visible item's; x0 and x1 are its left and right edges. A line with no
// visible text (an empty line) joins the line before it, so it has no position.
function lines(items) {
  const result = [];
  let line = null;
  for (const item of items) {
    line = line || { text: '', y: null, height: 0, x0: Infinity, x1: -Infinity };
    line.text += item.str + (item.hasEOL ? '\n' : '');
    if (item.str.trim()) {
      if (line.y === null) line.y = item.y;
      line.height = Math.max(line.height, item.height);
      line.x0 = Math.min(line.x0, item.x);
      line.x1 = Math.max(line.x1, item.x + item.width);
    }
    if (item.hasEOL) {
      addLine(result, line);
      line = null;
    }
  }
  if (line) addLine(result, line);
  return result;
}

function addLine(result, line) {
  const previous = result[result.length - 1];
  if (line.y !== null) result.push(line);
  else if (previous) previous.text += line.text;
  else result.push({ ...line, y: Infinity, x0: 0, x1: 0 });   // leading empty text: stays first
}

// Splits the lines where the stored order jumps back up the page by more than half a
// line: each part (a block) reads top to bottom.
function blocks(pageLines) {
  const result = [];
  let previous = null;
  for (const line of pageLines) {
    if (!previous || line.y > previous.y + Math.max(line.height, previous.height) / 2) {
      result.push([]);
    }
    result[result.length - 1].push(line);
    previous = line;
  }
  return result;
}

// True if the block continues the group's column (see the header): every group line
// at the heights the block covers overlaps the block left to right, or there is none.
function sameColumn(group, block) {
  const top = Math.max(...block.map((line) => line.y));
  const bottom = Math.min(...block.map((line) => line.y));
  const x0 = Math.min(...block.map((line) => line.x0));
  const x1 = Math.max(...block.map((line) => line.x1));
  return group
    .filter((line) => line.y <= top && line.y >= bottom)
    .every((line) => line.x0 < x1 && x0 < line.x1);
}

// Merged lines are reordered, so each needs its own line end.
function endLine(line) {
  return line.text.endsWith('\n') ? line : { ...line, text: `${line.text}\n` };
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
// text clearly continues there and neither side of the break is code. Changes pages in
// place.
function repairCutSentences(pages) {
  for (let i = 0; i < pages.length - 1; i++) {
    const page = pages[i];
    const next = pages[i + 1];
    if (!page || !next || ENDS_SENTENCE.test(page) || !continues(page, next)) continue;
    if (CODE.test(page.slice(page.lastIndexOf('\n') + 1))) continue;   // last line
    if (CODE.test(next.split('\n', 1)[0])) continue;                    // next first line

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
