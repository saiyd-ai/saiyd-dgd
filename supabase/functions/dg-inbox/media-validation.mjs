// Shared admission checks for n8n and the inbox endpoint. These identify supported
// signatures/containers; they do not validate document contents or detect malware.
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const SPECS = Object.freeze({
  'application/pdf': { kind: 'pdf', extensions: ['pdf'], defaultName: 'document.pdf' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { kind: 'xlsx', extensions: ['xlsx'], defaultName: 'workbook.xlsx' },
  'application/vnd.ms-excel': { kind: 'xls', extensions: ['xls'], defaultName: 'workbook.xls' },
  'image/jpeg': { kind: 'jpeg', extensions: ['jpg', 'jpeg'], defaultName: 'photo.jpg' },
  'image/png': { kind: 'png', extensions: ['png'], defaultName: 'photo.png' },
});

export function mediaSpec(mime) {
  if (typeof mime !== 'string') return null;
  const normalized = mime.trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(SPECS, normalized)) return null;
  return { mime: normalized, ...SPECS[normalized] };
}

export function supportedMediaName(mime, name) {
  const spec = mediaSpec(mime);
  if (!spec || typeof name !== 'string' || !name.trim() || name.length > 512 || /[\x00-\x1f]/.test(name)) return false;
  const extension = name.trim().split('.').at(-1).toLowerCase();
  return spec.extensions.includes(extension);
}

const invalid = () => { throw new Error('Unsupported or invalid attachment.'); };
const starts = (b, signature, offset = 0) => b.length >= offset + signature.length && signature.every((v, i) => b[offset + i] === v);
const ascii = b => Array.from(b, x => String.fromCharCode(x)).join('');
const u16 = (b, p) => (p >= 0 && p + 2 <= b.length) ? b[p] | b[p + 1] << 8 : invalid();
const u32 = (b, p) => (p >= 0 && p + 4 <= b.length) ? (b[p] | b[p + 1] << 8 | b[p + 2] << 16 | b[p + 3] << 24) >>> 0 : invalid();

function workbookZip(b) {
  // Read bounded central/local headers, not compressed XML. Workbook entry names
  // are evidence of an OOXML container, not proof that sheets/XML are valid.
  if (!starts(b, [0x50, 0x4b, 3, 4])) invalid();
  let end = -1;
  for (let p = b.length - 22; p >= Math.max(0, b.length - 65557); p--) {
    if (u32(b, p) === 0x06054b50 && p + 22 + u16(b, p + 20) === b.length) { end = p; break; }
  }
  if (end < 0 || u16(b, end + 4) || u16(b, end + 6)) invalid();
  const count = u16(b, end + 10), size = u32(b, end + 12), offset = u32(b, end + 16);
  if (!count || count > 4096 || count !== u16(b, end + 8) || offset + size > end) invalid();
  let p = offset, expanded = 0;
  const names = new Set();
  for (let i = 0; i < count; i++) {
    if (p + 46 > offset + size || u32(b, p) !== 0x02014b50) invalid();
    const flags = u16(b, p + 8), method = u16(b, p + 10), compressed = u32(b, p + 20), unpacked = u32(b, p + 24);
    const n = u16(b, p + 28), extra = u16(b, p + 30), comment = u16(b, p + 32), local = u32(b, p + 42);
    if ((flags & 1) || ![0, 8].includes(method) || u16(b, p + 34) || !n || n > 4096 || p + 46 + n + extra + comment > offset + size) invalid();
    expanded += unpacked;
    if (unpacked > 32 * 1024 * 1024 || expanded > 64 * 1024 * 1024) invalid();
    const name = ascii(b.subarray(p + 46, p + 46 + n));
    if (names.has(name) || /\\|(^|\/)\.\.(\/|$)/.test(name)) invalid();
    names.add(name);
    if (local + 30 > offset || u32(b, local) !== 0x04034b50 || u16(b, local + 8) !== method || (u16(b, local + 6) & 1)) invalid();
    const ln = u16(b, local + 26), le = u16(b, local + 28);
    if (ln !== n || local + 30 + ln + le + compressed > offset || ascii(b.subarray(local + 30, local + 30 + ln)) !== name) invalid();
    if ((name === '[Content_Types].xml' || name === 'xl/workbook.xml') && (!compressed || !unpacked)) invalid();
    p += 46 + n + extra + comment;
  }
  if (p !== offset + size || !names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) invalid();
}

function workbookCfb(b) {
  // Follow the bounded CFB FAT directory chain and require a Workbook/Book stream.
  // This excludes ordinary Word/PowerPoint CFB files; BIFF records remain unread.
  if (!starts(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) || b.length < 512 || u16(b, 28) !== 0xfffe) invalid();
  const major = u16(b, 26), shift = u16(b, 30), sector = 2 ** shift;
  if (!((major === 3 && shift === 9) || (major === 4 && shift === 12)) || u16(b, 32) !== 6 || b.length % sector) invalid();
  const sectors = b.length / sector - 1, fats = [], usedFat = new Set();
  const fatCount = u32(b, 44), difCount = u32(b, 72);
  if (!fatCount || fatCount > sectors || difCount > 32) invalid();
  const addFat = id => { if (id === 0xffffffff) return; if (id >= sectors || usedFat.has(id)) invalid(); usedFat.add(id); fats.push(id); };
  for (let i = 0; i < 109; i++) addFat(u32(b, 76 + i * 4));
  let dif = u32(b, 68);
  const seenDif = new Set();
  for (let i = 0; i < difCount; i++) {
    if (dif >= sectors || seenDif.has(dif)) invalid();
    seenDif.add(dif);
    const start = (dif + 1) * sector;
    for (let p = start; p < start + sector - 4; p += 4) addFat(u32(b, p));
    dif = u32(b, start + sector - 4);
  }
  if (fats.length !== fatCount || (difCount && dif !== 0xfffffffe)) invalid();
  const next = id => {
    const f = fats[Math.floor(id / (sector / 4))];
    if (f === undefined) invalid();
    return u32(b, (f + 1) * sector + id % (sector / 4) * 4);
  };
  let dir = u32(b, 48), found = false;
  const seen = new Set();
  while (dir !== 0xfffffffe) {
    if (dir >= sectors || seen.has(dir) || seen.size >= 4096) invalid();
    seen.add(dir);
    const start = (dir + 1) * sector;
    for (let p = start; p < start + sector; p += 128) {
      if (b[p + 66] !== 2) continue;
      const length = u16(b, p + 64);
      if (length < 2 || length > 64 || length % 2) invalid();
      let name = '';
      for (let j = 0; j < length - 2; j += 2) name += String.fromCharCode(u16(b, p + j));
      if (name === 'Workbook' || name === 'Book') found = true;
      if (name === 'EncryptedPackage' || name === 'EncryptionInfo') invalid();
    }
    dir = next(dir);
  }
  if (!found) invalid();
}

export function validateMedia(bytes, mime, name) {
  const spec = mediaSpec(mime);
  if (!spec || !supportedMediaName(spec.mime, name) || !bytes || typeof bytes.length !== 'number' || !bytes.length || bytes.length > MAX_MEDIA_BYTES) invalid();
  const b = bytes;
  if (spec.kind === 'pdf' && !starts(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) invalid();
  if (spec.kind === 'jpeg' && !starts(b, [0xff, 0xd8, 0xff])) invalid();
  if (spec.kind === 'png' && !starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) invalid();
  if (spec.kind === 'xlsx') workbookZip(b);
  if (spec.kind === 'xls') workbookCfb(b);
  return spec;
}
