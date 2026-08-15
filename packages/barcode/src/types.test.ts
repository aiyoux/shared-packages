import { describe, expect, it } from 'vitest';
import {
  ALL_BARCODE_FORMAT_OPTIONS,
  BARCODE_FORMAT_OPTIONS,
  GENERATOR_FORMAT_OPTIONS,
  barcodeFormatLabel,
  mapDetectedFormat,
  microQrCapacityHint,
  suggestGeneratorFormat
} from './types.js';

describe('format lists', () => {
  it('keeps QR Mini and JAB generator-only', () => {
    expect(BARCODE_FORMAT_OPTIONS.map((o) => o.value)).toEqual(['qr', 'datamatrix', 'aztec']);
    expect(GENERATOR_FORMAT_OPTIONS).toBe(ALL_BARCODE_FORMAT_OPTIONS);
    expect(ALL_BARCODE_FORMAT_OPTIONS.some((o) => o.value === 'qrmini' && o.generatorOnly)).toBe(
      true
    );
  });

  it('labels known formats', () => {
    expect(barcodeFormatLabel('qr')).toBe('QR Code');
    expect(barcodeFormatLabel('qrmini')).toMatch(/Mini/i);
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
    expect(mapDetectedFormat('rMQR')).toBe('qr');
    expect(mapDetectedFormat('unknown')).toBe('qr');
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
