/**
 * Base64 fields arrive validated for shape by the JSON schema and are turned into bytes here,
 * where the length in *bytes* can finally be checked. The schema can only bound the number of
 * characters, and a length that matters — a `12`-byte IV, a `32`-byte digest — has to be checked
 * after decoding or not at all.
 */
import { fromBase64 } from "../bytes.ts";
import { invalid } from "../errors.ts";

export function decodeBytes(
  value: string,
  field: string,
  bounds: { exact?: number; max?: number; min?: number } = {},
): Uint8Array {
  const bytes = fromBase64(value);
  if (bytes === null) throw invalid(`${field} is not canonical base64`);
  if (bounds.exact !== undefined && bytes.length !== bounds.exact) {
    throw invalid(`${field} must be exactly ${bounds.exact} bytes`);
  }
  if (bounds.min !== undefined && bytes.length < bounds.min) {
    throw invalid(`${field} must be at least ${bounds.min} bytes`);
  }
  if (bounds.max !== undefined && bytes.length > bounds.max) {
    throw invalid(`${field} must be at most ${bounds.max} bytes`);
  }
  return bytes;
}
