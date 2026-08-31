/**
 * Known-answer vectors for Argon2id.
 *
 * 5.3 pins the implementation — `hash-wasm`, exact version, locked with an integrity check — and
 * requires this phase to check it against control vectors and to re-run them on every version
 * bump. WebCrypto has no Argon2id, so this is the only dependency in the package that produces key
 * material, and it is the only one whose bytes cannot be cross-checked against a second built-in
 * implementation. Vectors are what stands in for that.
 *
 * On RFC 9106 §5.3 specifically. The vector printed there feeds Argon2id four inputs: a password, a
 * salt, an 8-byte **secret** and 12 bytes of **associated data**. `hash-wasm@4.12.0` accepts the
 * first three and has no parameter for associated data at all, so that exact vector is not
 * reachable through this library — the finding is reported to the document rather than papered
 * over, and the test below states it as an assertion instead of a comment. What is checked in its
 * place is the full known-answer set of the Argon2 reference implementation
 * (`phc-winner-argon2`, `src/test.c`) for version 0x13, which is the same algorithm the RFC
 * standardises with an empty secret and empty associated data — exactly the shape this scheme uses.
 * Sibling variants argon2i and argon2d are checked too: they share the core, so a corrupted build
 * would have to be wrong consistently in three places to slip through.
 */
import { argon2d, argon2i, argon2id } from "hash-wasm";
import { describe, expect, it } from "vitest";

import {
  deriveInviteMaster,
  deriveInviteSecrets,
  INVITE_ARGON2_ITERATIONS,
  INVITE_ARGON2_MEMORY_KIB,
  INVITE_ARGON2_PARALLELISM,
  INVITE_MASTER_BYTES,
  inviteSalt,
  toHex,
} from "../src/index.js";

interface Vector {
  readonly iterations: number;
  readonly memorySize: number;
  readonly parallelism: number;
  readonly password: string;
  readonly salt: string;
  readonly hash: string;
}

/** phc-winner-argon2 `src/test.c`, Argon2id, version 0x13, 32-byte tag. */
const REFERENCE_ARGON2ID: readonly Vector[] = [
  {
    iterations: 2,
    memorySize: 1 << 16,
    parallelism: 1,
    password: "password",
    salt: "somesalt",
    hash: "09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7",
  },
  {
    iterations: 2,
    memorySize: 1 << 8,
    parallelism: 1,
    password: "password",
    salt: "somesalt",
    hash: "9dfeb910e80bad0311fee20f9c0e2b12c17987b4cac90c2ef54d5b3021c68bfe",
  },
  {
    iterations: 2,
    memorySize: 1 << 8,
    parallelism: 2,
    password: "password",
    salt: "somesalt",
    hash: "6d093c501fd5999645e0ea3bf620d7b8be7fd2db59c20d9fff9539da2bf57037",
  },
  {
    iterations: 1,
    memorySize: 1 << 16,
    parallelism: 1,
    password: "password",
    salt: "somesalt",
    hash: "f6a5adc1ba723dddef9b5ac1d464e180fcd9dffc9d1cbf76cca2fed795d9ca98",
  },
  {
    iterations: 4,
    memorySize: 1 << 16,
    parallelism: 1,
    password: "password",
    salt: "somesalt",
    hash: "9025d48e68ef7395cca9079da4c4ec3affb3c8911fe4f86d1a2520856f63172c",
  },
  {
    iterations: 2,
    memorySize: 1 << 16,
    parallelism: 1,
    password: "differentpassword",
    salt: "somesalt",
    hash: "0b84d652cf6b0c4beaef0dfe278ba6a80df6696281d7e0d2891b817d8c458fde",
  },
  {
    iterations: 2,
    memorySize: 1 << 16,
    parallelism: 1,
    password: "password",
    salt: "diffsalt",
    hash: "bdf32b05ccc42eb15d58fd19b1f856b113da1e9a5874fdcc544308565aa8141c",
  },
];

describe("Argon2id known-answer vectors", () => {
  it.each(REFERENCE_ARGON2ID)(
    "matches the reference implementation for t=$iterations m=$memorySize p=$parallelism $password/$salt",
    async (vector) => {
      const hash = await argon2id({
        password: vector.password,
        salt: vector.salt,
        iterations: vector.iterations,
        parallelism: vector.parallelism,
        memorySize: vector.memorySize,
        hashLength: 32,
        outputType: "hex",
      });
      expect(hash).toBe(vector.hash);
    },
  );

  it("matches the reference implementation for the argon2i and argon2d siblings", async () => {
    const options = {
      password: "password",
      salt: "somesalt",
      iterations: 2,
      parallelism: 1,
      memorySize: 1 << 16,
      hashLength: 32,
      outputType: "hex",
    } as const;
    expect(await argon2i(options)).toBe(
      "c1628832147d9720c5bd1cfd61367078729f6dfb6f8fea9ff98158e0d7816ed0",
    );
    expect(await argon2d(options)).toBe(
      "955e5d5b163a1b60bba35fc36d0496474fba4f6b59ad53628666f07fb2f93eaf",
    );
  });

  it("produces the version 0x13 encoding the reference implementation produces", async () => {
    // The encoded form carries the version and the parameters, so a build defaulting to the old
    // 0x10 version would be caught here even if a tag happened to match.
    const encoded = await argon2id({
      password: "password",
      salt: "somesalt",
      iterations: 2,
      parallelism: 1,
      memorySize: 1 << 16,
      hashLength: 32,
      outputType: "encoded",
    });
    expect(encoded.startsWith("$argon2id$v=19$m=65536,t=2,p=1$")).toBe(true);
  });

  it("honours the keyed-hash secret, and has no associated-data parameter at all", async () => {
    // The gap that puts RFC 9106 §5.3 out of reach, asserted rather than asserted-in-prose. The
    // secret changes the output, so the parameter is real; `ad` is silently ignored, so a caller
    // who passed associated data would get a hash computed without it — and this test is what
    // would fail if a future version started honouring it and changed every derived value.
    const base = {
      password: new Uint8Array(32).fill(1),
      salt: new Uint8Array(16).fill(2),
      iterations: 3,
      parallelism: 4,
      memorySize: 32,
      hashLength: 32,
      outputType: "hex",
    } as const;
    const plain = await argon2id(base);
    const keyed = await argon2id({ ...base, secret: new Uint8Array(8).fill(3) });
    expect(keyed).not.toBe(plain);

    const withAssociatedData = await argon2id({
      ...base,
      secret: new Uint8Array(8).fill(3),
      ad: new Uint8Array(12).fill(4),
    } as never);
    expect(withAssociatedData).toBe(keyed);
    // The RFC 9106 §5.3 tag, for the record. It is unreachable while `ad` is unsupported.
    expect(withAssociatedData).not.toBe(
      "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659",
    );
  });
});

describe("the invite derivation of 5.3", () => {
  it("uses the parameters the document fixes, and no others", () => {
    expect(INVITE_ARGON2_ITERATIONS).toBe(3);
    expect(INVITE_ARGON2_MEMORY_KIB).toBe(64 * 1024);
    expect(INVITE_ARGON2_PARALLELISM).toBe(1);
    expect(INVITE_MASTER_BYTES).toBe(96);
  });

  it("derives the salt from the code alone, deterministically", async () => {
    // salt = SHA-256(enc("nash-budget/invite/v1", UTF8(code))). Pinned as a vector so that a
    // change to the label, to `enc`, or to the normalisation of the code fails here loudly rather
    // than silently making every previously issued invite unopenable.
    expect(toHex(await inviteSalt("ABCDEFGHJKMN"))).toBe(
      "aeee63f8213e94f0b6b9c6a039642fee0263d1792f4b1412d2b85c78a0595db2",
    );
  });

  it("is a vector of its own at the scheme's parameters", async () => {
    // The document asks for "a vector of its own with the parameters of this scheme" alongside the
    // published ones. It pins the whole chain — normalisation, salt, Argon2id, split — so any
    // future change that would break already-issued invites has to be made deliberately.
    const master = await deriveInviteMaster("ABCDEFGHJKMN");
    expect(master).toHaveLength(96);
    expect(toHex(master)).toBe(
      "ca1bbf03761c93999d68e3305f8799f40abd2d28d5bb025f89a9cfbb598ae9a1" +
        "412e8ce2682423bcd3a39fefe261e5b6a0f9397db00d6f10f13ffa2b858a61db" +
        "29611536d990239678e8d45d01b60517f87076243a4dd0dea2ac24f2a3f8573d",
    );
  });

  it("splits into three thirds that share no bytes", async () => {
    const code = "ABCDEFGHJKMN";
    const master = await deriveInviteMaster(code);
    const secrets = await deriveInviteSecrets(code);
    expect(toHex(secrets.authToken)).toBe(toHex(master.slice(32, 64)));
    expect(toHex(secrets.bindKey)).toBe(toHex(master.slice(64, 96)));
    expect(toHex(secrets.authToken)).not.toBe(toHex(secrets.bindKey));
  });
});
