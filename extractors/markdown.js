// Markdown: each heading starts a new section, named by its heading path
// (e.g. "Installation > Windows"). Text before the first heading is named after the file.
// Lines inside fenced code blocks are never treated as headings.
// Not supported: "setext" headings (a line underlined with === or ---).

const { decode } = require('./text');

const HEADING = /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;
const FENCE = /^ {0,3}(```|~~~)/;

async function extract(buffer, fileName) {
  const sections = [];
  const path = [];         // heading titles by level: path[0] is the "#" heading
  let section = fileName;
  let lines = [];
  let inCode = false;

  const flush = () => {
    const text = lines.join('\n').trim();
    if (text) sections.push({ section, text });   // headings with no text of their own are skipped
    lines = [];
  };

  for (const line of decode(buffer).split('\n')) {
    if (FENCE.test(line)) inCode = !inCode;

    const heading = !inCode && line.match(HEADING);
    if (heading) {
      flush();
      const level = heading[1].length;
      path.length = level - 1;          // forget headings at this level and deeper
      path[level - 1] = heading[2];
      section = path.filter(Boolean).join(' > ');   // filter skips levels that were jumped over
      continue;
    }
    lines.push(line);
  }
  flush();

  return sections;
}

module.exports = { extract };
