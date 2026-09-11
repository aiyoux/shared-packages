const fs = require('fs');
const { loadCv } = require('./cvload.cjs');
const { loadRgba } = require('./img.cjs');
const { inside } = require('./render.cjs');

function iou(a, b, w, h) {
  if (!a || !b) return a === b ? 1 : 0;
  const step = Math.max(1, Math.round(Math.min(w, h) / 400));
  let i = 0, u = 0;
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const ia = inside(a, x + 0.5, y + 0.5), ib = inside(b, x + 0.5, y + 0.5);
    if (ia && ib) i++;
    if (ia || ib) u++;
  }
  return u ? i / u : 1;
}
const fmt = (q) => q ? q.map(p => `${Math.round(p.x)},${Math.round(p.y)}`).join(' ') : 'null';

async function run(label, detect, threshold = 0.85) {
  const cv = await loadCv();
  const manifest = JSON.parse(fs.readFileSync(`${__dirname}/corpus/manifest.json`, 'utf8'));
  let pass = 0;
  const rows = [];
  for (const m of manifest) {
    const img = await loadRgba(m.file);
    const t = Date.now();
    let quad = null, err = null;
    try { quad = detect(cv, img.buffer, img.width, img.height, {}); }
    catch (e) { err = e.message; }
    const ms = Date.now() - t;
    const score = err ? 0 : iou(quad, m.gt, img.width, img.height);
    const ok = m.gt === null ? (quad === null) : score >= threshold;
    if (ok) pass++;
    rows.push({ name: m.name, ok, score, ms, quad, gt: m.gt, err });
  }
  console.log(`\n=== ${label} ===`);
  for (const r of rows) {
    console.log(
      (r.ok ? ' PASS ' : '*FAIL*') + ' ' + r.name.padEnd(14) +
      ' iou=' + (r.gt === null ? (r.quad === null ? ' n/a' : '0.00') : r.score.toFixed(2)) +
      ' ' + String(r.ms).padStart(5) + 'ms' +
      (r.ok ? '' : '  got[' + fmt(r.quad) + '] want[' + fmt(r.gt) + ']') +
      (r.err ? '  ERR ' + r.err : '')
    );
  }
  console.log(`${label}: ${pass}/${rows.length} pass`);
  return { pass, total: rows.length, rows };
}
module.exports = { run, iou };
