// Plain text: the whole file is one section, named after the file. No title
// (the caller falls back to one made from the file name).

// Turns file bytes into text: UTF-8, no byte-order mark, Unix line endings.
function decode(buffer) {
  return buffer.toString('utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

async function extract(buffer, fileName) {
  const text = decode(buffer).trim();
  return { title: null, sections: text ? [{ section: fileName, text }] : [] };
}

module.exports = { extract, decode };
