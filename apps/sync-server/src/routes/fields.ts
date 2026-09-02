/**
 * Field schemas shared by the route bodies.
 *
 * Every body in this server is validated with `additionalProperties: false` and an explicit
 * `required` list. That is not tidiness: 5.3 permits the server a very short list of things it may
 * hold, and an open object schema is precisely how a field it may not hold arrives anyway.
 */
import { MAX_EMAIL_LENGTH } from "../limits.ts";

/** Base64 with the padding, of a bounded byte length. `4 * ceil(n / 3)` characters. */
export function base64Field(maxBytes: number, minBytes = 0): Record<string, unknown> {
  return {
    type: "string",
    minLength: minBytes === 0 ? 0 : 4 * Math.ceil(minBytes / 3),
    maxLength: 4 * Math.ceil(maxBytes / 3),
    pattern: "^[A-Za-z0-9+/]*={0,2}$",
  };
}

/**
 * 2.2: UUID v4, canonical lower case, refused rather than normalised.
 *
 * It is the only shape of identifier this server accepts, and that is deliberate. What stood
 * beside it was a bounded free string — one to `128` characters, any characters — applied to
 * `memberId` because 3.2 bounds the *length* of an identifier. Length is not the whole of the
 * rule: 3.2 also refuses control characters "in any string", the codec of `sync-protocol` refuses
 * them together with the bidirectional overrides, and `memberId` is a UUID by 2.1. So a
 * `memberId` of `"\u202eabcdefgh"` was accepted here, stored, and served back from
 * `GET /members` to a screen where it reverses the text beside it — a value checked in one layer
 * and used in another without the check. The remedy is not a longer deny-list: it is to accept
 * the shape the document names, which admits nothing to deny.
 */
export const uuidField = {
  type: "string",
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
} as const;

/**
 * The characters an address may use before the `@`: RFC 5322 `atext`, and nothing else. Note what
 * is *not* in it — the dot, which separates atoms and therefore cannot be one; and the quote, so
 * the quoted form `"john doe"@example.test` is out. See {@link emailField}.
 */
const EMAIL_ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]";

/**
 * One label of a host name, the LDH rule: letters, digits and inner hyphens, `1` to `63`
 * characters, never beginning or ending with a hyphen. A domain in a script of its own reaches
 * this in its `xn--` form, which is why the rule needs no exception for one.
 */
const EMAIL_LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";

/** The last label, which a mailbox needs and which is never one character long. */
const EMAIL_TLD = "[A-Za-z0-9][A-Za-z0-9-]{0,61}[A-Za-z0-9]";

/**
 * The address of 6.1: ASCII, `local@label.label`, at most `64` characters before the `@` and
 * {@link MAX_EMAIL_LENGTH} in all.
 *
 * **Why the set is this narrow.** The address is not a piece of text this server carries, it is
 * the identifier a person signs in by. It is compared for equality, it is `UNIQUE` on `account`
 * and the primary key of `login_code`, it names the per-address bucket of 6.1's three-an-hour, it
 * is an input to the HMAC over the one-time code, and it reaches a person's eyes twice over — the
 * delivery sink writes it to a terminal (`main.ts`) and a real transport puts it in a `To:` line,
 * and the client shows the person the address they are signed in as. Every one of those uses
 * assumes two things: that one address is one string, and that what is displayed is what was
 * typed. Neither survives outside ASCII without machinery this server does not have —
 * NFC to settle which of several encodings of one letter is stored, UTS-46 for the domain, and a
 * mixed-script rule for the rest. Rejecting is not a limitation of ambition, it is the only
 * honest answer available at this size.
 *
 * What the old pattern excluded was `@` and whitespace, so it took `\u202eadmin@example.test`,
 * a zero-width space inside a name, a byte-order mark in front of one, and a Cyrillic `а` in
 * place of the Latin one — an address that displays as somebody else's, in the field by which
 * people recognise each other. It is the defect that was found in `memberId`, in a place where
 * it is worse: a `memberId` reaches a screen, an e-mail address reaches a screen *and* decides
 * which account a code is sent to.
 *
 * **What is deliberately refused although RFC 5321 permits it.** The quoted local part and the
 * address literal `user@[192.0.2.1]`: both are legal, neither is ever typed by a person signing
 * in to a family budget, and both put quoting and bracket syntax into a value that is displayed.
 * An internationalised address (SMTPUTF8) is refused too, and that is a decision with a cost —
 * an owner whose only address is in Cyrillic cannot register. It is taken knowingly: this server
 * could store such an address but not deliver a code to it, and an account whose code cannot
 * arrive is worse than a refusal that says so at the door.
 *
 * **On the shape of the expression.** The separators are excluded from the classes they separate
 * — a dot is not `atext` and not part of a label — so every character of a candidate has exactly
 * one place it can go and the match cannot backtrack over its own ambiguity. With `maxLength` on
 * top of that, the pattern is a linear scan of a bounded string.
 */
export const emailField = {
  type: "string",
  // The floor is the pattern's own: `a@b.co` is the shortest string it can match. The ceiling is
  // here rather than in the pattern because it is the one bound the regular expression should not
  // be asked to count to.
  maxLength: MAX_EMAIL_LENGTH,
  // 5321 keeps the local part to `64` octets. Asserted ahead of the match, because the only `@`
  // this pattern admits is the separator, so "an `@` within the first 64 characters" is exactly
  // "a local part of at most 64".
  pattern:
    `^(?=.{1,64}@)${EMAIL_ATOM}+(?:\\.${EMAIL_ATOM}+)*` +
    `@(?:${EMAIL_LABEL}\\.)+${EMAIL_TLD}$`,
} as const;

export const loginCodeField = { type: "string", pattern: "^[0-9]{6}$" } as const;

export const epochField = {
  type: "integer",
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
} as const;

/** A decimal string, because query strings are strings and this server coerces nothing. */
export const numericQueryField = { type: "string", pattern: "^(0|[1-9][0-9]{0,15})$" } as const;

export function body(
  properties: Record<string, unknown>,
  required: readonly string[],
): Record<string, unknown> {
  return { type: "object", additionalProperties: false, required: [...required], properties };
}
