import { describe, expect, it } from 'vitest';
import {
  ALL_BARCODE_FORMAT_OPTIONS,
  BARCODE_FORMAT_OPTIONS,
  GENERATOR_FORMAT_OPTIONS,
  LINEAR_BARCODE_FORMAT_OPTIONS,
  PRODUCT_BARCODE_FORMAT_OPTIONS,
  barcodeFormatLabel,
  eanUpcCapacityHint,
  isLinearBarcodeFormat,
  mapDetectedFormat,
  microQrCapacityHint,
  normalizeLinearDigits,
  suggestGeneratorFormat
} from './types.js';

describe('format lists', () => {
  it('keeps QR Mini and JAB generator-only, and 1D out of the signaling picker', () => {
    expect(BARCODE_FORMAT_OPTIONS.map((o) => o.value)).toEqual(['qr', 'datamatrix', 'aztec']);
    expect(LINEAR_BARCODE_FORMAT_OPTIONS.map((o) => o.value)).toEqual([
      'ean13',
      'ean8',
      'upca',
      'upce'
    ]);
    expect(PRODUCT_BARCODE_FORMAT_OPTIONS.map((o) => o.value)).toEqual([
      'qr',
      'datamatrix',
      'aztec',
      'ean13',
      'ean8',
      'upca',
      'upce'
    ]);
    expect(GENERATOR_FORMAT_OPTIONS).toBe(ALL_BARCODE_FORMAT_OPTIONS);
    expect(ALL_BARCODE_FORMAT_OPTIONS.some((o) => o.value === 'qrmini' && o.generatorOnly)).toBe(
      true
    );
  });

  it('labels known formats', () => {
    expect(barcodeFormatLabel('qr')).toBe('QR Code');
    expect(barcodeFormatLabel('qrmini')).toMatch(/Mini/i);
    expect(barcodeFormatLabel('ean13')).toBe('EAN-13');
    expect(barcodeFormatLabel('upca')).toBe('UPC-A');
  });
});

describe('mapDetectedFormat', () => {
  it('treats locked scanner mode as authoritative', () => {
    expect(mapDetectedFormat('QRCode', 'aztec')).toBe('aztec');
    expect(mapDetectedFormat('whatever', 'jabcode')).toBe('jabcode');
  });

  it('maps native / wasm format strings in smart mode', () => {
    expect(mapDetectedFormat('qr_code')).toBe('qr');
    expect(mapDetectedFormat('MicroQRCode')).toBe('qrmini');
    expect(mapDetectedFormat('data_matrix')).toBe('datamatrix');
    expect(mapDetectedFormat('aztec')).toBe('aztec');
    expect(mapDetectedFormat('ean_13')).toBe('ean13');
    expect(mapDetectedFormat('EAN13')).toBe('ean13');
    expect(mapDetectedFormat('ean_8')).toBe('ean8');
    expect(mapDetectedFormat('upc_a')).toBe('upca');
    expect(mapDetectedFormat('UPCE')).toBe('upce');
    expect(mapDetectedFormat('EANUPC')).toBe('ean13');
    expect(mapDetectedFormat('rMQR')).toBe('qr');
    expect(mapDetectedFormat('unknown')).toBe('qr');
  });

  it('locks individual EAN/UPC modes and maps the eanupc group', () => {
    expect(mapDetectedFormat('UPCA', 'ean8')).toBe('ean8');
    expect(mapDetectedFormat('ean_13', 'eanupc')).toBe('ean13');
    expect(mapDetectedFormat('upc_e', 'eanupc')).toBe('upce');
  });
});

describe('linear digits', () => {
  it('strips spaces and dashes', () => {
    expect(normalizeLinearDigits('590 1234-12345 7')).toBe('5901234123457');
    expect(isLinearBarcodeFormat('ean13')).toBe(true);
    expect(isLinearBarcodeFormat('qr')).toBe(false);
  });

  it('hints when EAN/UPC length is wrong', () => {
    expect(eanUpcCapacityHint('5901234123457', 'ean13')).toBeNull();
    expect(eanUpcCapacityHint('590-1234-12345-7', 'ean13')).toBeNull();
    expect(eanUpcCapacityHint('oats', 'ean13')).toMatch(/12–13 digits/i);
    expect(eanUpcCapacityHint('123', 'upca')).toMatch(/11–12 digits/i);
    expect(eanUpcCapacityHint('12345678', 'ean8')).toBeNull();
  });
});

describe('microQrCapacityHint', () => {
  it('accepts short alphanumeric and tiny byte payloads', () => {
    expect(microQrCapacityHint('HI12345')).toBeNull();
    expect(microQrCapacityHint('abc')).toBeNull();
  });

  it('rejects long alphanumeric and lowercase URLs', () => {
    expect(microQrCapacityHint('ABCDEFGHIJKLMNOPQRSTUV')).toMatch(/21 alphanumeric/i);
    expect(microQrCapacityHint('https://example.com/path')).toMatch(/15 bytes/i);
  });
});

describe('suggestGeneratorFormat', () => {
  it('suggests EAN/UPC for digit-only GTINs', () => {
    expect(suggestGeneratorFormat('5901234123457')?.format).toBe('ean13');
    expect(suggestGeneratorFormat('012345678905')?.format).toBe('upca');
    expect(suggestGeneratorFormat('12345670')?.format).toBe('ean8');
  });

  it('suggests QR Mini for short payloads', () => {
    expect(suggestGeneratorFormat('HI')).toEqual({
      format: 'qrmini',
      reason: expect.stringMatching(/QR Mini/i)
    });
  });

  it('suggests Data Matrix then JAB as payload grows', () => {
    expect(suggestGeneratorFormat('x'.repeat(300))?.format).toBe('datamatrix');
    expect(suggestGeneratorFormat('x'.repeat(900))?.format).toBe('jabcode');
  });
});
