/**
 * Normalize zxing/zint SVG for crisp screen rendering:
 * strip XML prolog/DOCTYPE, add shape-rendering + viewBox.
 */
export function normalizeBarcodeSvg(svg: string): string {
  let s = svg
    .replace(/<\?xml[^?]*\?>/gi, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .trim();

  if (!/shape-rendering\s*=/i.test(s)) {
    s = s.replace(/<svg\b/i, '<svg shape-rendering="crispEdges"');
  }

  if (!/viewBox\s*=/i.test(s)) {
    const wh = s.match(/<svg\b[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/i);
    const hw = s.match(/<svg\b[^>]*\bheight="([\d.]+)"[^>]*\bwidth="([\d.]+)"/i);
    const w = wh?.[1] ?? hw?.[2];
    const h = wh?.[2] ?? hw?.[1];
    if (w && h) {
      s = s.replace(/<svg\b([^>]*)>/i, `<svg$1 viewBox="0 0 ${w} ${h}">`);
    }
  }

  return s;
}

/** Encode SVG markup as a data URL suitable for <img src> or download. */
export function svgToDataUrl(svg: string): string {
  const normalized = normalizeBarcodeSvg(svg);
  const utf8 = unescape(encodeURIComponent(normalized));
  return `data:image/svg+xml;base64,${btoa(utf8)}`;
}

export function isSvgDataUrl(dataUrl: string | null | undefined): boolean {
  return !!dataUrl && dataUrl.startsWith('data:image/svg+xml');
}

/** Decode an SVG data URL back to markup (for inline rendering). */
export function dataUrlToSvgMarkup(dataUrl: string): string | null {
  if (!isSvgDataUrl(dataUrl)) return null;
  try {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return null;
    const meta = dataUrl.slice(0, comma);
    const body = dataUrl.slice(comma + 1);
    if (/;base64/i.test(meta)) {
      return decodeURIComponent(escape(atob(body)));
    }
    return decodeURIComponent(body);
  } catch {
    return null;
  }
}

/** File extension for a barcode data URL (svg preferred when present). */
export function barcodeFileExtension(dataUrl: string | null | undefined): 'svg' | 'png' {
  return isSvgDataUrl(dataUrl) ? 'svg' : 'png';
}

/**
 * Rasterize a barcode data URL to a high-res PNG data URL.
 * SVG is drawn to canvas (sharp modules); existing PNG is returned as-is.
 */
export async function barcodeDataUrlToPng(
  dataUrl: string,
  /** Minimum output edge in CSS pixels before devicePixelRatio scaling */
  minEdge = 1024
): Promise<string | null> {
  if (!dataUrl) return null;
  if (!isSvgDataUrl(dataUrl) && dataUrl.startsWith('data:image/png')) {
    return dataUrl;
  }

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const natW = Math.max(1, img.naturalWidth || img.width || 1);
        const natH = Math.max(1, img.naturalHeight || img.height || 1);
        const longSide = Math.max(natW, natH);
        const scale = Math.max(1, Math.ceil(minEdge / longSide));
        const w = Math.round(natW * scale);
        const h = Math.round(natH * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/png'));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/** Trigger a browser download for a data URL. */
export function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

export function moduleSideFromSvg(svg: string | null | undefined): number | null {
  if (!svg) return null;
  const m = svg.match(/\bwidth="([\d.]+)"/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}
