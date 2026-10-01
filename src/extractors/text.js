// Plain text: the whole file is one section, named after the file. No title
// (the caller falls back to one made from the file name). Chunks start with that
// made-up title ("Nimbus Admin Handbook") instead of the file name, whose hyphens and
// extension say nothing to the embedding; the section stays the file name for
// citations.

const { titleFromFileName } = require('./title');

// Turns file bytes into text: UTF-8, no byte-order mark, Unix line endings.
function decode(buffer) {
  return buffer.toString('utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

async function extract(buffer, fileName) {
  const text = decode(buffer).trim();
  const prefix = titleFromFileName(fileName);
  return { title: null, sections: text ? [{ section: fileName, text, prefix }] : [] };
}

module.exports = { extract, decode };
