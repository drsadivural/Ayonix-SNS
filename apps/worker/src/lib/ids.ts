const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Prefixed, time-sortable random identifiers (e.g. tgt_01h...). */
export function newId(prefix: string): string {
  const time = Date.now().toString(32).padStart(10, '0');
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let rand = '';
  for (const b of bytes) rand += ALPHABET[b & 31];
  return `${prefix}_${time}${rand}`;
}

export function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const nowIso = () => new Date().toISOString();
