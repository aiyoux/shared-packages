#!/usr/bin/env node
/** Generate expected hashes from owning-package ModelDef exports serialized to JSON.
 * node scripts/hash-catalog.mjs /absolute/catalog.json /absolute/verified-catalog.json
 * Stream hashes without storing multi-GB weights or accepting floating HF revisions.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createBLAKE3 } from 'hash-wasm';
const [input, output] = process.argv.slice(2);
if (!input || !output || input === output) throw new Error('Provide separate input and output JSON paths');
const catalog = JSON.parse(await readFile(input, 'utf8'));
for (const def of catalog) {
  if (def.builtIn) continue;
  if (def.origin.kind === 'hf' && !/^[a-f0-9]{40}$/.test(def.origin.revision)) {
    const response = await fetch(`https://huggingface.co/api/models/${def.origin.repo}/revision/${encodeURIComponent(def.origin.revision)}`);
    if (!response.ok) throw new Error(`${def.id}: cannot resolve revision (${response.status})`);
    const data = await response.json();
    if (!/^[a-f0-9]{40}$/.test(data.sha)) throw new Error(`${def.id}: invalid resolved revision`);
    def.origin.revision = data.sha;
  }
  for (const file of def.files) {
    // Pinned HF paths take precedence over old floating URLs in the input.
    const url = def.origin.kind === 'hf'
      ? `https://huggingface.co/${def.origin.repo}/resolve/${def.origin.revision}/${file.path}` : file.url;
    if (!url) continue; // User-supplied weights have no authoritative expected hash.
    if (new URL(url).protocol !== 'https:') throw new Error('Model sources must use HTTPS');
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error(`${def.id}/${file.path}: HTTP ${response.status}`);
    const hash = await createBLAKE3(); hash.init(); let bytes = 0;
    for await (const chunk of response.body) { hash.update(chunk); bytes += chunk.byteLength; }
    if (file.bytes != null && file.bytes !== bytes) throw new Error(`${def.id}/${file.path}: expected ${file.bytes} bytes, received ${bytes}`);
    file.bytes = bytes; file.blake3 = hash.digest('hex'); file.url = url;
    process.stderr.write(`${def.id}/${file.path}: ${bytes} bytes verified\n`);
  }
}
await writeFile(output, JSON.stringify(catalog, null, 2) + '\n');
