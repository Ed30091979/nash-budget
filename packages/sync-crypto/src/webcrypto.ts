/**
 * The primitives, all of them from WebCrypto.
 *
 * `SYNC_ARCHITECTURE.md` 5.2: WebCrypto is present both in the browser and in Node 24, so one
 * implementation covers the PWA, the Capacitor shell and the server tests, and no separate crypto
 * library is linked for AES-GCM. The same holds for HKDF, ECDH P-256, SHA-256 and HMAC. The single
 * exception in this package is Argon2id, which WebCrypto does not have at all — see `invite.ts`.
 *
 * Nothing here is exported from the package index: these are the shared building blocks, and every
 * construction of the scheme is expressed in terms of them in the modules that own it.
 */
import { fail } from "./errors.js";

function requireWebcrypto(): Crypto {
  const available: Crypto | undefined = globalThis.crypto;
  if (available === undefined || available.subtle === undefined) {
    throw new Error("WebCrypto is unavailable: family synchronisation cannot run in this runtime");
  }
  return available;
}

const webcrypto = requireWebcrypto();
const subtle: SubtleCrypto = webcrypto.subtle;

/** Cryptographically strong random bytes — the only source of key material in this package. */
export function randomBytes(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0) fail("invalid_input");
  return webcrypto.getRandomValues(new Uint8Array(length));
}

/**
 * Narrowing at the WebCrypto boundary, in one place.
 *
 * The current TypeScript lib types `BufferSource` as `ArrayBufferView<ArrayBuffer>`, while a bare
 * `Uint8Array` is `Uint8Array<ArrayBufferLike>` — the wider type that also admits a view over a
 * `SharedArrayBuffer`. Every array this package builds comes from `new Uint8Array`, a `TextEncoder`
 * or a WebCrypto result, so it is always backed by an ordinary `ArrayBuffer`. Keeping the public
 * signatures on plain `Uint8Array` and narrowing here costs one function; narrowing at each call
 * site would cost a cast in twenty places, which is exactly how a real mismatch gets waved through.
 */
function source(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes as Uint8Array<ArrayBuffer>;
}

export const SHA256_BYTES = 32;

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-256", source(data)));
}

export async function hmacSha256(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const macKey = await subtle.importKey("raw", source(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", macKey, source(message)));
}

/**
 * HKDF-SHA-256, always to 32 bytes.
 *
 * The two parameters are not interchangeable, and 5.4 spells out why. `salt` is a non-secret
 * random value whose job is to separate derivations made from the same input keying material: a
 * pair of static ECDH keys yields *always the same* shared secret, so without a fresh salt every
 * wrapping key for one pair of devices would repeat the previous one. `info` adds no entropy; it
 * binds the output to a context — the epoch, the rotation attempt, both device identifiers and
 * both key fingerprints — so the key is useless anywhere else.
 */
export async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length = 32,
): Promise<Uint8Array> {
  const base = await subtle.importKey("raw", source(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: source(salt), info: source(info) }, base, length * 8);
  return new Uint8Array(bits);
}

export const AES_GCM_IV_BYTES = 12;
/** The 128-bit tag lives inside the ciphertext, so an empty plaintext still costs this much. */
export const AES_GCM_TAG_BYTES = 16;
export const AES_KEY_BYTES = 32;

/**
 * Imports 32 raw bytes as an AES-GCM key.
 *
 * `extractable` is a decision, not a detail. The family key is stored extractable (5.1) because
 * `wrapKey` refuses to work with a non-extractable key and the wrap is needed both for the invite
 * and for rotation. Keys derived for a single wrap are imported non-extractable: they exist for
 * one operation and nothing needs their bytes afterwards.
 */
export async function importAesKey(raw: Uint8Array, extractable = false): Promise<CryptoKey> {
  if (raw.length !== AES_KEY_BYTES) fail("invalid_input");
  return subtle.importKey("raw", source(raw), { name: "AES-GCM", length: 256 }, extractable, [
    "encrypt",
    "decrypt",
  ]);
}

export async function exportAesKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await subtle.exportKey("raw", key));
}

export async function aesGcmEncrypt(
  key: CryptoKey,
  iv: Uint8Array,
  plaintext: Uint8Array,
  additionalData: Uint8Array,
): Promise<Uint8Array> {
  if (iv.length !== AES_GCM_IV_BYTES) fail("invalid_input");
  const sealed = await subtle.encrypt(
    { name: "AES-GCM", iv: source(iv), additionalData: source(additionalData), tagLength: AES_GCM_TAG_BYTES * 8 },
    key,
    source(plaintext),
  );
  return new Uint8Array(sealed);
}

/**
 * AES-GCM open. Returns `undefined` on a failed tag check rather than throwing, so that the caller
 * chooses the refusal: every caller in this package has its own error code, and the underlying
 * `OperationError` from WebCrypto must never reach the user — it carries no information about the
 * cause and would put an implementation-defined string where a decision belongs.
 */
export async function aesGcmDecrypt(
  key: CryptoKey,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  additionalData: Uint8Array,
): Promise<Uint8Array | undefined> {
  if (iv.length !== AES_GCM_IV_BYTES) return undefined;
  if (ciphertext.length < AES_GCM_TAG_BYTES) return undefined;
  try {
    const opened = await subtle.decrypt(
      { name: "AES-GCM", iv: source(iv), additionalData: source(additionalData), tagLength: AES_GCM_TAG_BYTES * 8 },
      key,
      source(ciphertext),
    );
    return new Uint8Array(opened);
  } catch {
    return undefined;
  }
}

const ECDH_P256 = { name: "ECDH", namedCurve: "P-256" } as const;

/**
 * A device key pair: ECDH P-256, private half non-extractable.
 *
 * P-256 rather than X25519 because it is present in WebCrypto on every target browser, Safari
 * included (5.4). The pair is used for one thing only — delivering the family key to a device,
 * during rotation and when a wrap of the current epoch is issued (5.5).
 */
export async function generateEcdhKeyPair(): Promise<CryptoKeyPair> {
  return (await subtle.generateKey(ECDH_P256, false, ["deriveBits"])) as CryptoKeyPair;
}

export async function exportSpki(publicKey: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await subtle.exportKey("spki", publicKey));
}

export async function importSpki(spki: Uint8Array): Promise<CryptoKey> {
  try {
    return await subtle.importKey("spki", source(spki), ECDH_P256, true, []);
  } catch {
    return fail("invalid_input");
  }
}

/** ECDH on P-256: 256 bits of shared secret, the X coordinate of the shared point. */
export async function ecdhSharedSecret(privateKey: CryptoKey, publicKey: CryptoKey): Promise<Uint8Array> {
  const bits = await subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  return new Uint8Array(bits);
}
