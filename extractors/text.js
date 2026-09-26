// Plain text: the whole file is one section, named after the file.

// Turns file bytes into text: UTF-8, no byte-order mark, Unix line endings.
function decode(buffer) {
  return buffer.toString('utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

async function extract(buffer, fileName) {
  const text = decode(buffer).trim();
  return text ? [{ section: fileName, text }] : [];
}

module.exports = { extract, decode };
