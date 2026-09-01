/**
 * Base64 for the wire, written out rather than borrowed.
 *
 * `btoa` is not available in every runtime this package targets and would need a byte-to-latin1
 * dance anyway; `Buffer` is Node-only and this package's `src` program deliberately cannot see
 * the Node types. Sixteen lines of table lookup are cheaper than either.
 *
 * The decoder is strict on purpose: it is fed by the server, so a shape it accepts loosely is a
 * shape the server chooses. Padding must be exact, the alphabet closed, and a trailing group must
 * not carry bits that the byte count cannot hold.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const REVERSE = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let index = 0; index < ALPHABET.length; index += 1) {
    table[ALPHABET.charCodeAt(index)] = index;
  }
  return table;
})();

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 0b11) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : ALPHABET[((b & 0b1111) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : ALPHABET[c & 0b111111];
  }
  return out;
}

/** Returns `null` rather than throwing: every caller of this decoder is parsing untrusted input. */
export function fromBase64(text: string): Uint8Array | null {
  if (typeof text !== "string" || text.length % 4 !== 0) return null;
  let padding = 0;
  if (text.endsWith("==")) padding = 2;
  else if (text.endsWith("=")) padding = 1;
  const groups = text.length / 4;
  const bytes = new Uint8Array(groups * 3 - padding);
  let cursor = 0;
  for (let index = 0; index < text.length; index += 4) {
    const quad = [0, 0, 0, 0];
    for (let offset = 0; offset < 4; offset += 1) {
      const code = text.charCodeAt(index + offset);
      const isPad = code === 0x3d && index + 4 === text.length && offset >= 4 - padding;
      if (isPad) continue;
      const value = code < 128 ? REVERSE[code]! : -1;
      if (value < 0) return null;
      quad[offset] = value;
    }
    if (index + 4 === text.length) {
      // A padded group must not carry bits the byte count cannot hold. Without this the same
      // ciphertext has several spellings, and "the same envelope" stops being a property of the
      // bytes — which is what the whole `opId` bookkeeping is built on.
      if (padding === 2 && (quad[1]! & 0b1111) !== 0) return null;
      if (padding === 1 && (quad[2]! & 0b11) !== 0) return null;
    }
    const triple = (quad[0]! << 18) | (quad[1]! << 12) | (quad[2]! << 6) | quad[3]!;
    if (cursor < bytes.length) bytes[cursor++] = (triple >> 16) & 0xff;
    if (cursor < bytes.length) bytes[cursor++] = (triple >> 8) & 0xff;
    if (cursor < bytes.length) bytes[cursor++] = triple & 0xff;
  }
  return bytes;
}
