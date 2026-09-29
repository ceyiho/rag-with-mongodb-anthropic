// Splits sections into overlapping chunks. Sections are hard boundaries (one section
// never shares a chunk with another); the extractor decides what a section is, e.g.
// each Markdown heading starts one, and a plain-text file is a single section. Inside a section, split points are
// tried in order: paragraphs, then sentences, then lines, then words.
//
// Each chunk's text starts with its section name, so the embedding knows the context.
// Sizes apply to the whole chunk text, including that prefix.

const config = require('./config');

const SENTENCE_END = /(?<=[.!?]["')\]]?)\s+/;
const FENCE = /^ {0,3}(```|~~~)/;

function splitSections(sections, { targetSize, maxSize, overlap } = config.chunking) {
  const chunks = [];
  for (const { section, text } of sections) {
    const prefix = `${section}\n\n`;
    const sizes = {
      targetSize: targetSize - prefix.length,
      maxSize: maxSize - prefix.length,
      overlap,
    };
    for (const body of splitSection(text, sizes)) {
      chunks.push({ section, chunkIndex: chunks.length, text: prefix + body });
    }
  }
  return chunks;
}

function splitSection(text, { targetSize, maxSize, overlap }) {
  if (text.length <= maxSize) return [text];   // a section that fits stays whole

  const bodies = [];
  let current = [];

  for (const unit of toUnits(text, maxSize)) {
    if (current.length && measure(current) + unit.sep.length + unit.text.length > targetSize) {
      bodies.push(join(current));
      // Start the next chunk with the end of the previous one, if there is room.
      const room = maxSize - unit.sep.length - unit.text.length;
      const tail = overlapText(current[current.length - 1], overlap, room);
      current = tail ? [{ text: tail, sep: '', isCode: false }] : [];
    }
    current.push(unit);
  }
  if (current.length) bodies.push(join(current));

  return bodies;
}

// Breaks a section into units no longer than maxSize. Each unit remembers the
// separator that joins it to the unit before it.
function toUnits(text, maxSize) {
  const units = [];
  for (const paragraph of toParagraphs(text)) {
    if (paragraph.text.length <= maxSize) {
      units.push({ ...paragraph, sep: '\n\n' });
      continue;
    }
    const pieces = paragraph.isCode
      ? paragraph.text.split('\n').flatMap((line) => fitWords(line, maxSize))
      : paragraph.text.split(SENTENCE_END).flatMap((sentence) => fitLines(sentence, maxSize));
    pieces.forEach((piece, i) => units.push({
      text: piece,
      isCode: paragraph.isCode,
      sep: i === 0 ? '\n\n' : (paragraph.isCode ? '\n' : ' '),
    }));
  }
  return units;
}

// Paragraphs are separated by blank lines. A fenced code block is one paragraph,
// even if it contains blank lines.
function toParagraphs(text) {
  const paragraphs = [];
  let lines = [];
  let inCode = false;

  const flush = () => {
    const joined = lines.join('\n');
    if (joined.trim()) paragraphs.push({ text: inCode ? joined : joined.trim(), isCode: inCode });
    lines = [];
  };

  for (const line of text.split('\n')) {
    if (FENCE.test(line)) {
      if (!inCode) {
        flush();
        inCode = true;
        lines.push(line);
      } else {
        lines.push(line);
        flush();
        inCode = false;
      }
    } else if (!inCode && !line.trim()) {
      flush();
    } else {
      lines.push(line);
    }
  }
  flush();

  return paragraphs;
}

function fitLines(text, maxSize) {
  if (text.length <= maxSize) return [text];
  return text.split('\n').flatMap((line) => fitWords(line, maxSize));
}

// Last resort: cut at spaces (or mid-word, for a single word longer than maxSize).
function fitWords(text, maxSize) {
  if (text.length <= maxSize) return [text];
  const pieces = [];
  let piece = '';
  for (const word of text.split(' ')) {
    if (piece && piece.length + 1 + word.length > maxSize) {
      pieces.push(piece);
      piece = '';
    }
    piece = piece ? `${piece} ${word}` : word;
    while (piece.length > maxSize) {
      pieces.push(piece.slice(0, maxSize));
      piece = piece.slice(maxSize);
    }
  }
  if (piece) pieces.push(piece);
  return pieces;
}

// The end of a unit, as whole sentences up to `overlap` characters, so the next chunk
// never starts mid-sentence. If even the last sentence is longer, it is used only when
// it is at most twice `overlap`; otherwise there is no overlap. `room` is what is left
// under maxSize. Code is not repeated as overlap.
function overlapText(unit, overlap, room) {
  if (unit.isCode) return '';
  const sentences = unit.text.split(SENTENCE_END);
  const tail = takeTail(sentences, Math.min(overlap, room));
  if (tail) return tail;
  const last = sentences[sentences.length - 1];
  return last.length <= Math.min(overlap * 2, room) ? last : '';
}

function takeTail(parts, budget) {
  const taken = [];
  let length = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    const added = parts[i].length + (taken.length ? 1 : 0);
    if (length + added > budget) break;
    taken.unshift(parts[i]);
    length += added;
  }
  return taken.join(' ');
}

function join(units) {
  return units.map((unit, i) => (i ? unit.sep : '') + unit.text).join('');
}

function measure(units) {
  return join(units).length;
}

module.exports = { splitSections };
