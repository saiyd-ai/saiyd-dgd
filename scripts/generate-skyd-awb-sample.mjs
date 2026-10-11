import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { renderAwbDraftPdf } from '../supabase/functions/skyd-prepare/skyd-awb-pdf.mjs';

const require = createRequire(import.meta.url);
const search = process.env.CODEX_WORKSPACE_NODE_MODULES ? [process.env.CODEX_WORKSPACE_NODE_MODULES] : undefined;
const pdfLib = require(require.resolve('pdf-lib', { paths: search }));
const out = resolve(process.argv[2] || 'output/pdf/skyd-awb-synthetic-draft.pdf');
const fields = {
  awb: '02012345675', shipper: 'DEMO SHIPPING SERVICES LLC\nPort Saeed, Dubai\nUNITED ARAB EMIRATES',
  consignee: 'DEMO CARGO SOLUTIONS\n8411 NW 74th Street\nMiami FL 33166, UNITED STATES',
  origin: 'DWC', destination: 'MIA', pieces: 27, grossWeight: 10284,
  goods: 'CONSOLIDATION CARGO AS PER ATTACHED HOUSE MANIFEST\n27 PALLETS STC 490 MASTER CARTONS\nHS CODE 33030010, 27 SLAC',
  dimensions: 'VOLUME 39.62 CBM', handling: 'SHC-RMD/EAW\nREVIEW HOUSE MANIFEST BEFORE FINAL APPROVAL', carrier: 'LUFTHANSA',
  issuer: 'JFS LOGISTICS FZCO.\nP.O BOX 54782, W/H F18\nDUBAI AIRPORT FREE ZONE\nDUBAI, TEL:+97142521786',
  agentIataCode: '8645305',
};
if (process.argv.includes('--overflow')) {
  fields.shipper = Array.from({ length: 25 }, (_, n) => `SHIPPER LINE ${n + 1} FULL ADDRESS`).join('\n');
  fields.consignee = 'RECIPIENT-' + 'ABC123'.repeat(75);
  fields.goods = Array.from({ length: 90 }, (_, n) => `GOODS LINE ${n + 1} PRESERVED IN DRAFT`).join('\n');
  fields.handling = Array.from({ length: 15 }, (_, n) => `HANDLING LINE ${n + 1} REVIEW SOURCE`).join('\n');
}
const bytes = await renderAwbDraftPdf(fields, { pdfLib, jobNo: 'AEXP-DEMO00465', version: 1 });
await mkdir(resolve(out, '..'), { recursive: true });
await writeFile(out, bytes);
process.stdout.write(JSON.stringify({ path: out, bytes: bytes.length, synthetic: true }) + '\n');
