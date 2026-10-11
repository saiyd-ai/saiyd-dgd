'use strict';
const PDF = Buffer.from('%PDF-1.7\nSYNTHETIC ONLY');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
function workbookZip(names = ['[Content_Types].xml', 'xl/workbook.xml']) {
  const locals = [], central = [];
  let offset = 0;
  for (const name of names) {
    const n = Buffer.from(name), contents = Buffer.from('<synthetic/>');
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(contents.length, 18); local.writeUInt32LE(contents.length, 22); local.writeUInt16LE(n.length, 26);
    locals.push(local, n, contents);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6);
    c.writeUInt32LE(contents.length, 20); c.writeUInt32LE(contents.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, n); offset += local.length + n.length + contents.length;
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
function workbookCfb(stream = 'Workbook') {
  const b = Buffer.alloc(1536);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(b);
  b.writeUInt16LE(3, 26); b.writeUInt16LE(0xfffe, 28); b.writeUInt16LE(9, 30); b.writeUInt16LE(6, 32);
  b.writeUInt32LE(1, 44); b.writeUInt32LE(0, 48); b.writeUInt32LE(0xfffffffe, 68);
  for (let i = 0; i < 109; i++) b.writeUInt32LE(i ? 0xffffffff : 1, 76 + i * 4);
  Buffer.from(stream + '\0', 'utf16le').copy(b, 512); b.writeUInt16LE((stream.length + 1) * 2, 576); b[578] = 2;
  b.writeUInt32LE(0, 628); b.writeUInt32LE(4, 632);
  for (let i = 0; i < 128; i++) b.writeUInt32LE(i === 0 ? 0xfffffffe : i === 1 ? 0xfffffffd : 0xffffffff, 1024 + i * 4);
  return b;
}
module.exports = { PDF, JPEG, PNG, workbookZip, workbookCfb };
