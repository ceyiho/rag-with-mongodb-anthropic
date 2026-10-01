// PDF (text-based): each page is a section, named by its PDF page number ("page 12",
// as a PDF viewer counts, not the number printed on the page). Pages with no text
// (covers, full-page pictures) give no section. The title comes from the PDF's
// metadata, or null if it has none (or only a placeholder like "Untitled").
// Chunks start with the title (from the file name if there is none) instead of
// "page 12", which says nothing about the content; the section stays "page 12" for
// citations. If running headers or footers name chapters, the page's chapter follows
// the title, like a Markdown heading path: "Title > Chapter 2: Syncing".
//
// Reading order: a PDF stores a page's text in any order, and pdf.js returns it as
// stored. Some PDFs store all the prose first and the code blocks after it, so code
// would land at the end of the page. A page's text is rebuilt from its lines: where the
// stored order jumps back up the page, the text from there (a block) is either
// - merged into the text before it, line by line from top to bottom, if that text is in
//   the same column: at the heights the block covers, every line before it overlaps it
//   left to right, or there is none and the block lies within the text's column (it
//   fills a gap, like code between paragraphs);
// - or kept after it, if they sit side by side: columns, or table cells.
// A page with no jump comes out exactly as pdf.js returns it.
//
// Cleanup before splitting into sections:
// - Running headers and footers are dropped: a line in the top or bottom MARGIN of the
//   page, standing APART from the text next to it (a gap of at least that many line
//   heights), whose text repeats there on a run of at least MIN_RUN pages, each at most
//   MAX_STEP pages after the one before (every page, or every other page in books that
//   alternate headers). Digits are ignored, so "Page 3 of 6" repeats as "Page # of #".
//   Only the lines in such a run are dropped. Text areas can reach into the margin, so
//   the gap test keeps code lines, and the run keeps body sentences a book repeats on
//   scattered pages (e.g. "Define a pipeline ready to perform the aggregation:" on
//   pages 95, 144 and 200). Chapter names are dropped too, unless the chapter is
//   shorter than MIN_RUN pages.
// - Chapter names come from those dropped lines: a header or footer text on at least
//   MIN_RUN pages that gives way to another one at the same edge (top or bottom), the
//   pages of one ending before the other's start. A text that never changes (the book
//   title on every other page, a copyright line) says nothing about the page, so it is
//   no chapter name; nor is a text whose pages span another's (the book title after a
//   "Preface" header, a "Summary" header in every chapter). So if chapter names
//   alternate with section names, the section names are used: the most specific.
//   A page between a chapter's headers belongs to it; a page without one (a chapter's
//   first page, often) belongs to the chapter starting or ending within MAX_STEP
//   pages, the starting one first; a page further away has no chapter (title only).
//   Not handled: a page number on the same line as the chapter name ("42  Chapter 3"),
//   which makes every page's text different.
// - A page's first or last line is dropped if it is only a page number ("6", "vi",
//   "Page 6", "6 of 20"), for documents too short for the rule above.
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
const MARGIN = 0.1;           // top and bottom 10% of the page height
const APART = 2;              // line heights between a header or footer and the body
const MIN_RUN = 3;            // pages a header or footer must repeat on, close together
const MAX_STEP = 2;           // pages from one repeat to the next
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

    const pageLines = items.map(lines);
    const running = runningLines(pageLines, await pageBounds(pdf));
    const pages = pageLines.map((pl) => stripPageNumber(pageText(pl.filter((line) => !running.has(line)))));
    const totalChars = pages.reduce((sum, page) => sum + page.length, 0);
    const average = Math.round(totalChars / totalPages);
    if (average < config.pdf.minAverageChars) {
      throw new Error(`This PDF has almost no text (${average} characters per page on average). `
        + 'It looks scanned or made of images; only text-based PDFs are supported.');
    }

    repairCutSentences(pages);
    const title = titleFromMeta(info);
    const prefix = title || titleFromFileName(fileName);
    const chapters = chapterNames(pageLines, running);
    const sections = pages
      .map((page, i) => ({
        section: `page ${i + 1}`,
        text: page,
        prefix: chapters[i] ? `${prefix} > ${chapters[i]}` : prefix,
      }))
      .filter(({ text }) => text);

    return { title, sections };
  } finally {
    await pdf.loadingTask.destroy();   // frees pdf.js memory for this file
  }
}

// Each page's bottom and top edge, in the same units as the text positions.
async function pageBounds(pdf) {
  const bounds = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const [, bottom, , top] = (await pdf.getPage(n)).view;
    bounds.push({ bottom, top });
  }
  return bounds;
}

// The running headers and footers of all pages (see the header), as a map from each
// line to its edge ("top" or "bottom").
function runningLines(pageLines, bounds) {
  const found = new Map();   // "top|bottom text" -> [{ page, line, edge }]
  pageLines.forEach((pl, page) => {
    const { bottom, top } = bounds[page];
    const band = (top - bottom) * MARGIN;
    for (const line of pl) {
      if (!Number.isFinite(line.y)) continue;
      const edge = line.y >= top - band ? 'top' : line.y <= bottom + band ? 'bottom' : null;
      if (!edge || !standsApart(line, pl)) continue;
      const key = `${edge} ${line.text.trim().replace(/\d+/g, '#').replace(/\s+/g, ' ')}`;
      if (!found.has(key)) found.set(key, []);
      found.get(key).push({ page, line, edge });
    }
  });
  const running = new Map();
  for (const hits of found.values()) {
    for (const run of runs(hits)) {
      if (new Set(run.map((hit) => hit.page)).size >= MIN_RUN) {
        for (const hit of run) running.set(hit.line, hit.edge);
      }
    }
  }
  return running;
}

// Each page's chapter name from the running headers and footers (see the header), or
// null.
function chapterNames(pageLines, running) {
  const texts = new Map();   // "edge text" -> { edge, text, first, last, pages }
  pageLines.forEach((pl, page) => {
    for (const line of pl) {
      const edge = running.get(line);
      if (!edge) continue;
      const text = line.text.trim().replace(/\s+/g, ' ');
      const entry = texts.get(`${edge} ${text}`) || { edge, text, first: page, pages: new Set() };
      entry.last = page;
      entry.pages.add(page);
      texts.set(`${edge} ${text}`, entry);
    }
  });
  const long = [...texts.values()].filter((entry) => entry.pages.size >= MIN_RUN);
  const chapters = long
    .filter((entry) => {
      const others = long.filter((other) => other !== entry && other.edge === entry.edge);
      return others.some((other) => other.last < entry.first || other.first > entry.last)
        && !others.some((other) => entry.first <= other.first && other.last <= entry.last);
    })
    .sort((a, b) => (a.edge === b.edge ? 0 : a.edge === 'top' ? -1 : 1));   // headers first

  return pageLines.map((_, page) => {
    const chapter = chapters.find((c) => c.first <= page && page <= c.last)
      || chapters.find((c) => c.first > page && c.first - page <= MAX_STEP)
      || chapters.find((c) => c.last < page && page - c.last <= MAX_STEP);
    return chapter ? chapter.text : null;
  });
}

// Splits hits (in page order) into runs: a new run starts where the next hit is more
// than MAX_STEP pages after the one before.
function runs(hits) {
  const result = [];
  for (const hit of hits) {
    const run = result[result.length - 1];
    if (run && hit.page - run[run.length - 1].page <= MAX_STEP) run.push(hit);
    else result.push([hit]);
  }
  return result;
}

// True if no other line on the page is within APART line heights above or below it.
// Lines on the same baseline (a header in two parts) don't count.
function standsApart(line, pl) {
  return pl.every((other) => other === line || !Number.isFinite(other.y)
    || Math.abs(other.y - line.y) < line.height / 2
    || Math.abs(other.y - line.y) >= APART * line.height);
}

// A page's text in reading order (see the header), from its lines (see lines()).
function pageText(pageLines) {
  const groups = [];   // each a list of lines; groups follow each other in stored order
  for (const block of blocks(pageLines)) {
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

// Joins a page's items into lines. Items are pdf.js text pieces, in stored order, with
// their position (x from the left, y up from the bottom) and size; pdf.js marks each
// line's last item with hasEOL. A line's y is its first visible item's; x0 and x1 are
// its left and right edges. A line with no visible text (an empty line) joins the line
// before it, so it has no position.
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
// at the heights the block covers overlaps the block left to right, or there is none
// and some group line does (the block fills a gap in the column).
function sameColumn(group, block) {
  const top = Math.max(...block.map((line) => line.y));
  const bottom = Math.min(...block.map((line) => line.y));
  const x0 = Math.min(...block.map((line) => line.x0));
  const x1 = Math.max(...block.map((line) => line.x1));
  const overlaps = (line) => line.x0 < x1 && x0 < line.x1;
  const level = group.filter((line) => line.y <= top && line.y >= bottom);
  return level.length ? level.every(overlaps) : group.some(overlaps);
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
