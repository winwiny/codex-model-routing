import { MAX_INPUT_BYTES } from './jev-constants.mjs';
import { JevError } from './jev-errors.mjs';

const SECRET_NAME = /(?:^|_)(?:api_?key|private_?key|seed_?phrase|mnemonic|authorization|signature|secret|password|passwd|token)(?:$|_)/i;
const SECRET_VALUE = /\b(?:vck_[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;

export function hasSensitiveMaterial(value) {
  if (typeof value === 'string') return SECRET_VALUE.test(value);
  if (Array.isArray(value)) return value.some(hasSensitiveMaterial);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => (
    (SECRET_NAME.test(key) && child !== null && child !== undefined && child !== '')
      || hasSensitiveMaterial(child)
  ));
}

export function assertSafeRequest(value) {
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(value), 'utf8'); }
  catch { throw new JevError('input_not_json', 'The request is not JSON serializable.', 2); }
  if (bytes > MAX_INPUT_BYTES) throw new JevError('input_too_large', 'The request exceeds the byte limit.', 2);
  if (hasSensitiveMaterial(value)) throw new JevError('sensitive_material_rejected', 'Sensitive material is not accepted.', 2);
  return bytes;
}
