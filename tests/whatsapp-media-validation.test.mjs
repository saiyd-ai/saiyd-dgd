import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_MEDIA_BYTES, mediaSpec, supportedMediaName, validateMedia } from '../supabase/functions/dg-inbox/media-validation.mjs';
import fixtures from './helpers/whatsapp-media-fixtures.cjs';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', XLS = 'application/vnd.ms-excel';
const samples = [
  [fixtures.PDF, 'application/pdf', 'document.pdf'], [fixtures.JPEG, 'image/jpeg', 'photo.JPG'],
  [fixtures.PNG, 'image/png', 'photo.png'], [fixtures.workbookZip(), XLSX, 'book.xlsx'], [fixtures.workbookCfb(), XLS, 'book.xls'],
];
test('supported MIME and extension pairs admit bounded matching signatures/containers', () => {
  for (const [bytes, mime, name] of samples) assert.equal(validateMedia(bytes, mime, name).mime, mime);
  assert.equal(mediaSpec(' IMAGE/JPEG ').mime, 'image/jpeg');
  assert.equal(supportedMediaName('image/jpeg', 'photo.jpeg'), true);
  for (const mime of ['application/zip', 'application/octet-stream', 'image/svg+xml', 'constructor', '__proto__']) assert.equal(mediaSpec(mime), null);
});
test('declared MIME and supplied extension cannot relabel conflicting bytes', () => {
  assert.throws(() => validateMedia(fixtures.PDF, 'image/jpeg', 'photo.jpg'));
  assert.throws(() => validateMedia(fixtures.PDF, 'application/pdf', 'document.pdf.exe'));
  assert.throws(() => validateMedia(fixtures.JPEG, 'image/jpeg', 'image.png'));
  assert.throws(() => validateMedia(fixtures.PDF, 'application/pdf', 'hidden\0.pdf'));
});
test('decoded cap allows the exact 10 MiB boundary and rejects larger/empty/truncated files', () => {
  const exact = Buffer.alloc(MAX_MEDIA_BYTES); fixtures.PDF.copy(exact);
  assert.equal(validateMedia(exact, 'application/pdf', 'max.pdf').kind, 'pdf');
  assert.throws(() => validateMedia(Buffer.concat([exact, Buffer.from([0])]), 'application/pdf', 'large.pdf'));
  assert.throws(() => validateMedia(Buffer.alloc(0), 'application/pdf', 'empty.pdf'));
  assert.throws(() => validateMedia(Buffer.from([0xff, 0xd8]), 'image/jpeg', 'truncated.jpg'));
});
test('XLSX requires both workbook entries instead of merely accepting an arbitrary ZIP', () => {
  assert.throws(() => validateMedia(Buffer.from('PK\x03\x04'), XLSX, 'fake.xlsx'));
  assert.throws(() => validateMedia(fixtures.workbookZip(['word/document.xml']), XLSX, 'word.xlsx'));
  assert.throws(() => validateMedia(fixtures.workbookZip(['[Content_Types].xml']), XLSX, 'incomplete.xlsx'));
  assert.throws(() => validateMedia(fixtures.workbookZip(['[Content_Types].xml', '../xl/workbook.xml']), XLSX, 'path.xlsx'));
});
test('ZIP encrypted flags, oversized expansion and malformed central bounds are rejected', () => {
  const encrypted = fixtures.workbookZip(); const dir = encrypted.readUInt32LE(encrypted.length - 6);
  encrypted.writeUInt16LE(1, dir + 8);
  assert.throws(() => validateMedia(encrypted, XLSX, 'encrypted.xlsx'));
  const huge = fixtures.workbookZip(); huge.writeUInt32LE(100 * 1024 * 1024, huge.readUInt32LE(huge.length - 6) + 24);
  assert.throws(() => validateMedia(huge, XLSX, 'bomb.xlsx'));
  const bad = fixtures.workbookZip(); bad.writeUInt32LE(0xffffffff, bad.length - 6);
  assert.throws(() => validateMedia(bad, XLSX, 'bad.xlsx'));
});
test('XLS requires a Workbook/Book CFB directory stream, and rejects encryption or directory cycles', () => {
  assert.equal(validateMedia(fixtures.workbookCfb('Book'), XLS, 'old.xls').kind, 'xls');
  assert.throws(() => validateMedia(fixtures.workbookCfb('WordDocument'), XLS, 'word.xls'));
  assert.throws(() => validateMedia(fixtures.workbookCfb('EncryptedPackage'), XLS, 'encrypted.xls'));
  const cycle = fixtures.workbookCfb(); cycle.writeUInt32LE(0, 1024);
  assert.throws(() => validateMedia(cycle, XLS, 'cycle.xls'));
});
