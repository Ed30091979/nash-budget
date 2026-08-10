/**
 * SHA-256, synchronous and dependency-free.
 *
 * The merge needs a tiebreaker no participant can maximise. Every identifier in this protocol
 * is a UUID v4, and a UUID has a largest string — `ffffffff-ffff-4fff-bfff-ffffffffffff` — which
 * anybody can simply write down. Ranking a tie by the identifier therefore handed the last word
 * to whoever picked the alphabetically largest one, which is the same lever as ranking by the
 * largest number, only in a smaller alphabet. A digest has no reachable maximum: moving it costs
 * a search per conflict instead of one hardcoded string.
 *
 * Why not WebCrypto: `crypto.subtle.digest` is asynchronous, and the total order it feeds is
 * used inside a comparator. Why not `node:crypto`: this package runs in the browser as well, and
 * the two implementations must agree bit for bit on every device or the family stops converging.
 * A local implementation is the only shape that is both synchronous and identical everywhere.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const ENCODER = new TextEncoder();
const HEX: string[] = Array.from({ length: 256 }, (_unused, value) => value.toString(16).padStart(2, "0"));
/** Reused between calls: the comparator hashes once per operation, but it does it a lot. */
const SCHEDULE = new Uint32Array(64);

/** SHA-256 of the UTF-8 encoding of `text`, as 64 lowercase hexadecimal characters. */
export function sha256Hex(text: string): string {
  const bytes = ENCODER.encode(text);
  const bitLength = bytes.length * 8;
  const total = (Math.floor((bytes.length + 8) / 64) + 1) * 64;
  const padded = new Uint8Array(total);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(total - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(total - 4, bitLength >>> 0);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  for (let offset = 0; offset < total; offset += 64) {
    for (let index = 0; index < 16; index += 1) SCHEDULE[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const w15 = SCHEDULE[index - 15]!;
      const w2 = SCHEDULE[index - 2]!;
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      SCHEDULE[index] = (SCHEDULE[index - 16]! + s0 + SCHEDULE[index - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let index = 0; index < 64; index += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + K[index]! + SCHEDULE[index]!) >>> 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  let hex = "";
  for (const word of [h0, h1, h2, h3, h4, h5, h6, h7]) {
    hex +=
      HEX[(word >>> 24) & 0xff]! + HEX[(word >>> 16) & 0xff]! + HEX[(word >>> 8) & 0xff]! + HEX[word & 0xff]!;
  }
  return hex;
}
