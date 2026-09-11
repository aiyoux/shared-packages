const fs = require('fs');
const { sharp } = require('./img.cjs');
const { Canvas } = require('./render.cjs');
const W = 720, H = 1200;

const noiseTex = (seed) => (u, v) => {
  const n = Math.sin((u * 37.1 + seed) * 91.7) * Math.cos((v * 53.3 + seed) * 71.3);
  return n * 6;
};
// large saturated cutting mat: green ground, fine grid, ruled lines
const matShader = (u, v) => {
  const gx = Math.abs(((u * 34) % 1) - 0.5) < 0.06;
  const gy = Math.abs(((v * 56) % 1) - 0.5) < 0.06;
  const fine = ((u * 170) % 1 < 0.4) && ((v * 280) % 1 < 0.4);
  let c = [22, 128, 112];
  if (fine) c = [40, 148, 132];
  if (gx || gy) c = [176, 206, 200];
  return c.map(k => k + noiseTex(3)(u, v));
};
// plain light-grey tray / placemat: LOW saturation competitor
const trayShader = (u, v) => [186, 188, 190].map(k => k + noiseTex(11)(u, v) * 1.4);
const woodShader = (u, v) => {
  const grain = Math.sin(v * 90 + Math.sin(u * 8) * 3) * 7 + Math.sin(v * 311) * 3;
  return [past(122 + grain), past(92 + grain * 0.8), past(64 + grain * 0.6)];
};
const past = (n) => n;
const deskShader = (tone) => (u, v) => [tone, tone, tone + 2].map(k => k + noiseTex(5)(u, v));
// a page: near-white, optional dense text rows
const pageShader = ({ tone = 238, text = false, sat = 0 } = {}) => (u, v) => {
  let l = tone + Math.sin(u * 6) * 1.5 + Math.sin(v * 4) * 1.5;
  if (text) {
    const row = (v - 0.08) * 46;
    const inRow = row > 0 && row < 38 && (row % 1) < 0.55;
    const margin = u > 0.1 && u < 0.9;
    const wordGap = (Math.sin(u * 130 + Math.floor(row) * 7) > -0.3);
    if (inRow && margin && wordGap) l = 62;
  }
  return [l, l - sat, l - sat * 1.4];
};

function scene(name, build) { return { name, build }; }

const SCENES = [
  // page on the big saturated grid mat (synthetic analogue of the real photo)
  scene('mat-synth', () => {
    const c = new Canvas(W, H);
    c.fill(() => [26, 26, 30]);
    const mat = [{x:-20,y:70},{x:W+20,y:96},{x:W+20,y:1080},{x:-20,y:1104}];
    c.quad(mat, matShader);
    const page = [{x:130,y:212},{x:590,y:206},{x:648,y:880},{x:78,y:892}];
    c.quad(page, pageShader());
    c.finish(1);
    return { c, gt: page };
  }),
  // page inside a big LOW-saturation grey tray: colour cue cannot help
  scene('tray-grey', () => {
    const c = new Canvas(W, H);
    c.fill(() => [34, 32, 30]);
    c.quad([{x:12,y:60},{x:706,y:74},{x:700,y:1120},{x:18,y:1134}], trayShader);
    const page = [{x:152,y:250},{x:566,y:244},{x:600,y:860},{x:120,y:872}];
    c.quad(page, pageShader());
    c.finish(2);
    return { c, gt: page };
  }),
  // dense-text page on wood: texture term must not reject a real document
  scene('desk-text', () => {
    const c = new Canvas(W, H);
    c.fill(woodShader);
    const page = [{x:96,y:180},{x:620,y:196},{x:598,y:940},{x:74,y:924}];
    c.quad(page, pageShader({ text: true }));
    c.finish(3);
    return { c, gt: page };
  }),
  // plain page, mild perspective, mid-grey desk
  scene('desk-plain', () => {
    const c = new Canvas(W, H);
    c.fill(deskShader(96));
    const page = [{x:120,y:230},{x:604,y:210},{x:640,y:940},{x:86,y:918}];
    c.quad(page, pageShader());
    c.finish(4);
    return { c, gt: page };
  }),
  // page on near-black surface
  scene('dark-surface', () => {
    const c = new Canvas(W, H);
    c.fill(deskShader(22));
    const page = [{x:140,y:260},{x:590,y:250},{x:614,y:900},{x:118,y:912}];
    c.quad(page, pageShader());
    c.finish(5);
    return { c, gt: page };
  }),
  // off-white page on light grey: low border contrast
  scene('low-contrast', () => {
    const c = new Canvas(W, H);
    c.fill(deskShader(196));
    const page = [{x:132,y:236},{x:596,y:228},{x:626,y:906},{x:104,y:918}];
    c.quad(page, pageShader({ tone: 236 }));
    c.finish(6);
    return { c, gt: page };
  }),
  // strong perspective
  scene('skew-strong', () => {
    const c = new Canvas(W, H);
    c.fill(deskShader(80));
    const page = [{x:206,y:196},{x:520,y:250},{x:660,y:930},{x:52,y:840}];
    c.quad(page, pageShader());
    c.finish(7);
    return { c, gt: page };
  }),
  // big dark book beside the page, similar size
  scene('book-beside', () => {
    const c = new Canvas(W, H);
    c.fill(deskShader(118));
    c.quad([{x:360,y:120},{x:700,y:130},{x:696,y:1080},{x:356,y:1070}], () => [38, 34, 46]);
    const page = [{x:40,y:300},{x:330,y:296},{x:342,y:800},{x:30,y:806}];
    c.quad(page, pageShader());
    c.finish(8);
    return { c, gt: page };
  }),
  // close-up: the page legitimately fills most of the frame
  scene('fills-frame', () => {
    const c = new Canvas(W, H);
    c.fill(deskShader(70));
    const page = [{x:38,y:90},{x:686,y:104},{x:678,y:1110},{x:30,y:1096}];
    c.quad(page, pageShader({ text: true }));
    c.finish(9);
    return { c, gt: page };
  }),
  // smaller sheet resting on a larger sheet: nesting between two documents
  scene('stacked-pages', () => {
    const c = new Canvas(W, H);
    c.fill(deskShader(64));
    c.quad([{x:58,y:150},{x:668,y:166},{x:656,y:1060},{x:46,y:1044}], pageShader({ tone: 214 }));
    const page = [{x:150,y:300},{x:566,y:310},{x:556,y:880},{x:140,y:872}];
    c.quad(page, pageShader({ tone: 246 }));
    c.finish(10);
    return { c, gt: page };
  }),
  // NO document: a bare mat must yield null, not the mat
  scene('no-doc-mat', () => {
    const c = new Canvas(W, H);
    c.fill(() => [26, 26, 30]);
    c.quad([{x:-20,y:70},{x:W+20,y:96},{x:W+20,y:1080},{x:-20,y:1104}], matShader);
    c.finish(11);
    return { c, gt: null };
  }),
  // NO document: bare wood desk must yield null
  scene('no-doc-desk', () => {
    const c = new Canvas(W, H);
    c.fill(woodShader);
    c.finish(12);
    return { c, gt: null };
  })
];

(async () => {
  const dir = __dirname;
  fs.mkdirSync(`${dir}/corpus`, { recursive: true });
  const manifest = [];
  for (const s of SCENES) {
    const { c, gt } = s.build();
    await sharp(c.toBuffer(), { raw: { width: W, height: H, channels: 3 } })
      .png().toFile(`${dir}/corpus/${s.name}.png`);
    manifest.push({ name: s.name, file: `${dir}/corpus/${s.name}.png`, gt });
  }
  // A real phone frame: a sheet of paper on a green cutting mat. This is the
  // scene the area-driven scorer used to fail on, reporting the mat as the page.
  manifest.push({
    name: 'mat-real', file: `${dir}/fixtures/page-on-cutting-mat.jpg`,
    gt: [{x:122,y:205},{x:598,y:203},{x:677,y:889},{x:65,y:894}]
  });
  fs.writeFileSync(`${dir}/corpus/manifest.json`, JSON.stringify(manifest, null, 2));
  console.log('scenes:', manifest.map(m => m.name).join(', '));
})();
