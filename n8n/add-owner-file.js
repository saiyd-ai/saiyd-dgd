// n8n Code node: JavaScript, Run Once for All Items. Shared media checks are
// prepended by the build script. This bounds uploads after the media download.
const OWNER = '971562977774';
const out = [], items = $input.all();
for (let i = 0; i < items.length; i++) {
  let parsed, bytes, spec, name;
  try {
    parsed = $('Parse').itemMatching(i).json;
    spec = mediaSpec(parsed?.mime);
    if (parsed?.from !== OWNER || parsed.body?.from !== OWNER || !['document', 'image'].includes(parsed.body.type) ||
        typeof parsed.body.message_id !== 'string' || !parsed.body.message_id || parsed.messageId !== parsed.body.message_id || !spec ||
        (parsed.body.type === 'image' && !['jpeg', 'png'].includes(spec.kind))) throw new Error('Invalid linkage');
    const keys = Object.keys(items[i].binary || {});
    if (keys.length !== 1) throw new Error('Invalid binary');
    bytes = await this.helpers.getBinaryDataBuffer(i, keys[0]);
    if (!Buffer.isBuffer(bytes)) throw new Error('Invalid binary');
    name = typeof parsed.fileName === 'string' && parsed.fileName.trim() ? parsed.fileName.trim() : spec.defaultName;
    validateMedia(bytes, spec.mime, name);
  } catch {
    throw new Error('Media validation failed: owner-linked PDF, XLSX/XLS, JPG/PNG of at most 10 MiB required.');
  }
  out.push({ json: {
    from: parsed.from, messageId: parsed.messageId,
    body: { ...parsed.body, file: { name, mime: spec.mime, base64: bytes.toString('base64') } },
  }, pairedItem: { item: i } });
}
return out;
