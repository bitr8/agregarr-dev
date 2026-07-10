/**
 * Image format detection from raw bytes.
 */

const RIFF_MAGIC = 0x52494646; // "RIFF"
const WEBP_FOURCC = 0x57454250; // "WEBP"

/**
 * Detect a WebP buffer by its RIFF container magic.
 *
 * Layout: bytes 0-3 are "RIFF", bytes 4-7 are the little-endian file size, and
 * bytes 8-11 are "WEBP".
 *
 * Used to tell an Agregarr-generated poster from one Plex owns: every poster
 * Agregarr uploads is composited to WebP, while Plex's own agent and provider
 * posters are JPEG. The implication only runs one way - an Agregarr poster is
 * always WebP, but a WebP poster is not necessarily Agregarr's, since a user can
 * upload one. Rely on it only to prove a poster is NOT ours.
 */
export function isWebpBuffer(buffer: Buffer): boolean {
  if (buffer.length < 12) {
    return false;
  }

  // Compare raw bytes, not `toString('ascii')` - Node masks the high bit when
  // decoding ascii, so 0xD2 0xC9 0xC6 0xC6 would decode to "RIFF".
  return (
    buffer.readUInt32BE(0) === RIFF_MAGIC &&
    buffer.readUInt32BE(8) === WEBP_FOURCC
  );
}
