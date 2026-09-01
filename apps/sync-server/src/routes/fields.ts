/**
 * Field schemas shared by the route bodies.
 *
 * Every body in this server is validated with `additionalProperties: false` and an explicit
 * `required` list. That is not tidiness: 5.3 permits the server a very short list of things it may
 * hold, and an open object schema is precisely how a field it may not hold arrives anyway.
 */
import { MAX_EMAIL_LENGTH, MAX_ID_LENGTH } from "../limits.ts";

/** Base64 with the padding, of a bounded byte length. `4 * ceil(n / 3)` characters. */
export function base64Field(maxBytes: number, minBytes = 0): Record<string, unknown> {
  return {
    type: "string",
    minLength: minBytes === 0 ? 0 : 4 * Math.ceil(minBytes / 3),
    maxLength: 4 * Math.ceil(maxBytes / 3),
    pattern: "^[A-Za-z0-9+/]*={0,2}$",
  };
}

/** 2.2: UUID v4, canonical lower case, refused rather than normalised. */
export const uuidField = {
  type: "string",
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
} as const;

/** 3.2: `targetId`, `memberId` and any reference to an entity — at most `128` characters. */
export const identifierField = {
  type: "string",
  minLength: 1,
  maxLength: MAX_ID_LENGTH,
} as const;

export const emailField = {
  type: "string",
  minLength: 3,
  maxLength: MAX_EMAIL_LENGTH,
  pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
} as const;

export const loginCodeField = { type: "string", pattern: "^[0-9]{6}$" } as const;

/** A positive integer that stays inside the safe range; epochs and cursors are counted, not measured. */
export const counterField = {
  type: "integer",
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
} as const;

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
