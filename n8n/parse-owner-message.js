// n8n Code node: JavaScript, Run Once for All Items. media-validation.mjs is
// prepended by scripts/build-whatsapp-intake.cjs; generated file is paste-ready.
const EXPECTED_WABA = '2911407919205442';
const EXPECTED_PHONE = '1388023121061452';
const ALLOWED_SENDER = '971562977774';
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const validId = v => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/\s/.test(v);
const out = [], seen = new Set();
for (const [inputIndex, item] of $input.all().entries()) {
  const root = item?.json;
  if (!isObject(root)) continue;
  const event = Object.prototype.hasOwnProperty.call(root, 'body') ? root.body : root;
  if (!isObject(event) || event.object !== 'whatsapp_business_account' || !Array.isArray(event.entry)) continue;
  for (const entry of event.entry) {
    if (!isObject(entry) || entry.id !== EXPECTED_WABA || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!isObject(change) || change.field !== 'messages') continue;
      const value = change.value;
      if (!isObject(value) || value.metadata?.phone_number_id !== EXPECTED_PHONE || !Array.isArray(value.messages)) continue;
      const names = new Map();
      for (const contact of (Array.isArray(value.contacts) ? value.contacts : [])) {
        if (isObject(contact) && typeof contact.wa_id === 'string' && typeof contact.profile?.name === 'string') names.set(contact.wa_id, contact.profile.name);
      }
      for (const message of value.messages) {
        if (!isObject(message) || message.from !== ALLOWED_SENDER || !validId(message.id) || seen.has(message.id)) continue;
        if (typeof message.timestamp !== 'string' || !/^[1-9]\d{0,12}$/.test(message.timestamp)) continue;
        let text = '', caption = '', mediaId = '', fileName = '', mime = '';
        if (message.type === 'text') {
          if (typeof message.text?.body !== 'string' || !message.text.body.trim()) continue;
          text = message.text.body;
        } else if (message.type === 'document' || message.type === 'image') {
          const media = message[message.type];
          if (!isObject(media) || !validId(media.id)) continue;
          const spec = mediaSpec(media.mime_type);
          if (!spec || (message.type === 'image' && !['jpeg', 'png'].includes(spec.kind))) continue;
          fileName = typeof media.filename === 'string' && media.filename.trim() ? media.filename.trim() : spec.defaultName;
          if (!supportedMediaName(spec.mime, fileName)) continue;
          mediaId = media.id; mime = spec.mime;
          caption = typeof media.caption === 'string' ? media.caption : '';
        } else continue;
        seen.add(message.id);
        out.push({ json: {
          from: message.from, messageId: message.id, mediaId, fileName, mime,
          body: { from: message.from, name: names.get(message.from) || '', type: message.type, text, caption, message_id: message.id, timestamp: message.timestamp },
        }, pairedItem: { item: inputIndex } });
      }
    }
  }
}
return out;
