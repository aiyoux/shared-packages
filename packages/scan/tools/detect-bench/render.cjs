// Tiny software renderer for synthetic scan scenes.
function solve(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < n; r++) {
      if (r === c || !A[r][c]) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}
/** Homography mapping the four src points onto the four dst points. */
function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], { x: X, y: Y } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
  }
  const h = solve(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}
function apply(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}
function inside(q, x, y) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const cr = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (cr === 0) continue;
    const s = cr > 0 ? 1 : -1;
    if (!sign) sign = s; else if (s !== sign) return false;
  }
  return true;
}
class Canvas {
  constructor(w, h) { this.w = w; this.h = h; this.d = new Float64Array(w * h * 3); }
  set(x, y, c) { const i = (y * this.w + x) * 3; this.d[i] = c[0]; this.d[i + 1] = c[1]; this.d[i + 2] = c[2]; }
  get(x, y) { const i = (y * this.w + x) * 3; return [this.d[i], this.d[i + 1], this.d[i + 2]]; }
  fill(shader) {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) this.set(x, y, shader(x, y));
  }
  /** Paint `shader(u,v)` (u,v in 0..1) through the quad, 2x supersampled. */
  quad(q, shader) {
    const H = homography(q, [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}]);
    const xs = q.map(p => p.x), ys = q.map(p => p.y);
    const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(this.w - 1, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(this.h - 1, Math.ceil(Math.max(...ys)));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      let n = 0, acc = [0, 0, 0];
      for (const [ox, oy] of [[0.25,0.25],[0.75,0.25],[0.25,0.75],[0.75,0.75]]) {
        const px = x + ox, py = y + oy;
        if (!inside(q, px, py)) continue;
        const uv = apply(H, px, py);
        const c = shader(Math.min(1, Math.max(0, uv.x)), Math.min(1, Math.max(0, uv.y)));
        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; n++;
      }
      if (!n) continue;
      const a = n / 4, base = this.get(x, y);
      this.set(x, y, [0, 1, 2].map(k => base[k] * (1 - a) + (acc[k] / n) * a));
    }
  }
  /** Multiplicative lighting gradient + gaussian sensor noise + slight blur. */
  finish(seed, { light = 0.22, noise = 3.5, blur = 1 } = {}) {
    let s = seed;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const lx = rnd(), ly = rnd();
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const dx = x / this.w - lx, dy = y / this.h - ly;
      const k = 1 - light * Math.min(1, (dx * dx + dy * dy) * 1.6);
      const g = (rnd() + rnd() + rnd() - 1.5) * noise;
      this.set(x, y, this.get(x, y).map(v => v * k + g));
    }
    for (let p = 0; p < blur; p++) {
      const src = this.d.slice();
      const at = (x, y, k) => src[(Math.min(this.h-1,Math.max(0,y)) * this.w + Math.min(this.w-1,Math.max(0,x))) * 3 + k];
      for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++)
        this.set(x, y, [0,1,2].map(k =>
          (at(x,y,k)*4 + at(x-1,y,k) + at(x+1,y,k) + at(x,y-1,k) + at(x,y+1,k)) / 8));
    }
  }
  toBuffer() {
    const out = Buffer.alloc(this.w * this.h * 3);
    for (let i = 0; i < this.w * this.h * 3; i++) out[i] = Math.max(0, Math.min(255, Math.round(this.d[i])));
    return out;
  }
}
module.exports = { Canvas, homography, apply, inside };
