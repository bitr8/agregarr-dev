import { isWebpBuffer } from '@server/utils/imageFormat';
import { describe, expect, it } from 'vitest';

const webp = (): Buffer => {
  const buf = Buffer.alloc(32);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(24, 4); // little-endian file size
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8 ', 12, 'ascii');
  return buf;
};

// JPEG SOI + APP0/JFIF, as Plex's agent posters arrive.
const jpeg = (): Buffer =>
  Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x00, 0x00,
  ]);

const png = (): Buffer =>
  Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  ]);

describe('isWebpBuffer', () => {
  it('detects a WebP buffer', () => {
    expect(isWebpBuffer(webp())).toBe(true);
  });

  it('rejects JPEG', () => {
    expect(isWebpBuffer(jpeg())).toBe(false);
  });

  it('rejects PNG', () => {
    expect(isWebpBuffer(png())).toBe(false);
  });

  // RIFF also carries WAV/AVI. Only the WEBP fourcc counts.
  it('rejects a non-WebP RIFF container', () => {
    const buf = Buffer.alloc(32);
    buf.write('RIFF', 0, 'ascii');
    buf.writeUInt32LE(24, 4);
    buf.write('WAVE', 8, 'ascii');
    expect(isWebpBuffer(buf)).toBe(false);
  });

  it('rejects buffers shorter than the magic', () => {
    expect(isWebpBuffer(Buffer.from('RIFF', 'ascii'))).toBe(false);
    expect(isWebpBuffer(Buffer.alloc(0))).toBe(false);
    expect(isWebpBuffer(Buffer.from('RIFF____WEB', 'ascii'))).toBe(false);
  });

  // Node's ascii decoder masks the high bit, so 0xD2 0xC9 0xC6 0xC6 decodes to
  // "RIFF" and 0xD7 0xC5 0xC2 0xD0 to "WEBP". Compare raw bytes instead.
  it('rejects high-bit bytes that decode to RIFF/WEBP as ascii', () => {
    const buf = Buffer.from([
      0xd2, 0xc9, 0xc6, 0xc6, 0x00, 0x00, 0x00, 0x00, 0xd7, 0xc5, 0xc2, 0xd0,
    ]);

    expect(buf.toString('ascii', 0, 4)).toBe('RIFF'); // the trap
    expect(isWebpBuffer(buf)).toBe(false);
  });

  it('does not match WEBP appearing outside the fourcc offset', () => {
    const buf = Buffer.alloc(32);
    buf.write('RIFF', 0, 'ascii');
    buf.writeUInt32LE(24, 4);
    buf.write('JUNK', 8, 'ascii');
    buf.write('WEBP', 16, 'ascii');
    expect(isWebpBuffer(buf)).toBe(false);
  });
});
