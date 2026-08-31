import { describe, expect, it } from "vitest";

import {
  CROCKFORD_ALPHABET,
  concatBytes,
  decodeEnc,
  decodeEncHead,
  enc,
  encodeCrockfordBits,
  equalBytes,
  fromHex,
  fromUtf8,
  normalizeCrockford,
  randomCrockford,
  SyncCryptoError,
  toHex,
  utf8,
} from "../src/index.js";

describe("enc — the one binding encoding of 5.2", () => {
  it("puts a four-byte big-endian length before every value", () => {
    expect(toHex(enc("ab"))).toBe("000000026162");
    expect(toHex(enc(1))).toBe("0000000131");
    expect(toHex(enc(new Uint8Array([0xff, 0x00])))).toBe("00000002ff00");
  });

  it("gives an empty result for an empty list", () => {
    expect(enc()).toHaveLength(0);
  });

  it("separates concatenations that plain juxtaposition would merge", () => {
    // The example 5.2 gives by name: without the length prefix, ("f1","23") and ("f12","3")
    // produce one and the same AAD, and an envelope moves between two families unforged.
    expect(toHex(enc("f1", "23"))).not.toBe(toHex(enc("f12", "3")));
    expect(toHex(enc("f1", 23))).not.toBe(toHex(enc("f12", 3)));
  });

  it("encodes integers as decimal text, so 1 and \"1\" agree", () => {
    expect(toHex(enc(12))).toBe(toHex(enc("12")));
  });

  it("refuses numbers that have no single decimal form", () => {
    for (const value of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => enc(value)).toThrow(SyncCryptoError);
    }
  });

  it("round-trips through decodeEnc and keeps the segment boundaries", () => {
    const parts = decodeEnc(enc("owner", 7, new Uint8Array([1, 2, 3])), 3);
    expect(parts).toHaveLength(3);
    expect(fromUtf8(parts[0]!)).toBe("owner");
    expect(fromUtf8(parts[1]!)).toBe("7");
    expect([...parts[2]!]).toEqual([1, 2, 3]);
  });

  it("refuses a list of a different length instead of defaulting the missing field", () => {
    const encoded = enc("a", "b");
    expect(() => decodeEnc(encoded, 3)).toThrow(SyncCryptoError);
    expect(() => decodeEnc(encoded, 1)).toThrow(SyncCryptoError);
  });

  it("refuses a truncated length prefix and a length past the end", () => {
    expect(() => decodeEnc(new Uint8Array([0, 0, 1]), 1)).toThrow(SyncCryptoError);
    expect(() => decodeEnc(new Uint8Array([0, 0, 0, 9, 1, 2]), 1)).toThrow(SyncCryptoError);
  });

  it("decodes a segment that is a view into a larger buffer", () => {
    const framed = concatBytes(new Uint8Array([9, 9]), enc("x"), new Uint8Array([9]));
    const inner = framed.subarray(2, framed.length - 1);
    expect(fromUtf8(decodeEnc(inner, 1)[0]!)).toBe("x");
  });
});

describe("decodeEncHead — the first field, before the count is known", () => {
  it("reads the first segment whatever follows it", () => {
    // The property the invite payload's version field of 5.3 rests on: the same first field is
    // read out of lists of two different lengths, so a payload written by a later version of the
    // scheme can still say which version it is.
    expect(fromUtf8(decodeEncHead(enc(1, "a", "b")))).toBe("1");
    expect(fromUtf8(decodeEncHead(enc(1, "a", "b", "c", "d", "e", "f")))).toBe("1");
    expect(decodeEncHead(enc(new Uint8Array(0), "a"))).toHaveLength(0);
  });

  it("refuses a truncated length prefix and a length past the end", () => {
    expect(() => decodeEncHead(new Uint8Array([0, 0, 1]))).toThrow(SyncCryptoError);
    expect(() => decodeEncHead(new Uint8Array([0, 0, 0, 9, 1, 2]))).toThrow(SyncCryptoError);
  });

  it("reads a segment that is a view into a larger buffer", () => {
    const framed = concatBytes(new Uint8Array([9, 9]), enc("x", "y"), new Uint8Array([9]));
    expect(fromUtf8(decodeEncHead(framed.subarray(2, framed.length - 1)))).toBe("x");
  });
});

describe("equalBytes", () => {
  it("compares by value and rejects a length difference", () => {
    expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it("does not stop at the first difference", () => {
    // A prefix oracle turns a search of the whole space into a search one byte at a time, so the
    // comparison must read every byte. Observing timing is not a test; reading the source is, and
    // this case at least pins the contract that a difference in byte zero is not special.
    expect(equalBytes(new Uint8Array([0, 0, 0]), new Uint8Array([1, 0, 0]))).toBe(false);
    expect(equalBytes(new Uint8Array([0, 0, 0]), new Uint8Array([0, 0, 1]))).toBe(false);
  });
});

describe("hex and UTF-8", () => {
  it("round-trips", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    expect([...fromHex(toHex(bytes))]).toEqual([...bytes]);
    expect(fromUtf8(utf8("код приглашения"))).toBe("код приглашения");
  });

  it("refuses malformed hex and malformed UTF-8 rather than substituting", () => {
    expect(() => fromHex("abc")).toThrow(SyncCryptoError);
    expect(() => fromHex("zz")).toThrow(SyncCryptoError);
    expect(() => fromUtf8(new Uint8Array([0xff, 0xfe]))).toThrow(SyncCryptoError);
  });
});

describe("Crockford Base32", () => {
  it("has exactly 32 symbols with I, L, O and U removed", () => {
    // 5.3 depends on this by number: 28 symbols would make a twelve-symbol code 57.7 bits, not 60.
    expect(CROCKFORD_ALPHABET).toHaveLength(32);
    expect(new Set(CROCKFORD_ALPHABET).size).toBe(32);
    for (const excluded of ["I", "L", "O", "U"]) expect(CROCKFORD_ALPHABET).not.toContain(excluded);
  });

  it("normalises the way a value read out loud gets written down", () => {
    expect(normalizeCrockford("abc-def ghj")).toBe("ABCDEFGHJ");
    expect(normalizeCrockford("IlO")).toBe("110");
  });

  it("refuses U and anything outside the alphabet instead of guessing", () => {
    expect(() => normalizeCrockford("ABU")).toThrow(SyncCryptoError);
    expect(() => normalizeCrockford("AB!")).toThrow(SyncCryptoError);
  });

  it("draws uniformly: the low five bits of a uniform byte carry no modulo bias", () => {
    const counts = new Map<string, number>();
    for (let byte = 0; byte < 256; byte += 1) {
      const symbol = randomCrockford(1, () => new Uint8Array([byte]));
      counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    }
    expect(counts.size).toBe(32);
    for (const count of counts.values()) expect(count).toBe(8);
  });

  it("renders a big-endian bit slice", () => {
    // 0xff 0x00 is 11111111 00000000; the first two groups of five are 11111 = 31 and 11100 = 28.
    expect(encodeCrockfordBits(new Uint8Array([0xff, 0x00]), 10)).toBe(
      `${CROCKFORD_ALPHABET[31]!}${CROCKFORD_ALPHABET[28]!}`,
    );
    expect(encodeCrockfordBits(new Uint8Array(16), 100)).toBe("0".repeat(20));
  });

  it("agrees with a bit-string computation over the whole 100-bit window", () => {
    // The reference: write the input out as bits, cut it into fives, index the alphabet. Slow and
    // obviously correct, which is what a reference is for.
    const bytes = new Uint8Array(16);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 37 + 11) & 0xff;
    const bits = [...bytes].map((byte) => byte.toString(2).padStart(8, "0")).join("");
    let expected = "";
    for (let offset = 0; offset < 100; offset += 5) {
      expected += CROCKFORD_ALPHABET[Number.parseInt(bits.slice(offset, offset + 5), 2)]!;
    }
    expect(encodeCrockfordBits(bytes, 100)).toBe(expected);
  });

  it("refuses a bit count that is not a whole number of symbols, or longer than the input", () => {
    expect(() => encodeCrockfordBits(new Uint8Array(4), 7)).toThrow(SyncCryptoError);
    expect(() => encodeCrockfordBits(new Uint8Array(4), 100)).toThrow(SyncCryptoError);
  });
});
