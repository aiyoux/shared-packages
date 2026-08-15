import { describe, expect, it } from 'vitest';
import {
  barcodeFileExtension,
  dataUrlToSvgMarkup,
  isSvgDataUrl,
  moduleSideFromSvg,
  normalizeBarcodeSvg,
  svgToDataUrl
} from './svg.js';

const raw = `<?xml version="1.0"?><!DOCTYPE svg><svg width="21" height="21"><rect/></svg>`;

describe('normalizeBarcodeSvg', () => {
  it('strips prolog, adds crispEdges and viewBox', () => {
    const out = normalizeBarcodeSvg(raw);
    expect(out).not.toMatch(/<\?xml/);
    expect(out).not.toMatch(/DOCTYPE/);
    expect(out).toMatch(/shape-rendering="crispEdges"/);
    expect(out).toMatch(/viewBox="0 0 21 21"/);
  });
});

describe('svg data urls', () => {
  it('round-trips markup through a data URL', () => {
    const url = svgToDataUrl(raw);
    expect(isSvgDataUrl(url)).toBe(true);
    expect(barcodeFileExtension(url)).toBe('svg');
    const markup = dataUrlToSvgMarkup(url);
    expect(markup).toMatch(/<svg/);
    expect(markup).toMatch(/viewBox="0 0 21 21"/);
  });

  it('reads module side from SVG width', () => {
    expect(moduleSideFromSvg('<svg width="33" height="33"></svg>')).toBe(33);
    expect(moduleSideFromSvg(null)).toBeNull();
  });
});
