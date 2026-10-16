// Free-form provider settings for the AI assistant: extra HTTP headers ("Name: value" per line) and extra request
// parameters (a JSON object merged into every request, e.g. temperature, top_p, max_tokens). No Node imports, so the
// settings dialog can validate with the same code.

/** Fields the assistant needs to work; extra parameters cannot replace them. */
export const RESERVED_BODY = ['messages', 'tools', 'system', 'tool_choice', 'stream'];

export function parseExtraHeaders(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [i, raw] of (text ?? '').split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) throw new Error(`Extra headers, line ${i + 1}: write it as "Header-Name: value".`);
    out[m[1]] = m[2];
  }
  return out;
}

export function parseExtraBody(text: string | undefined): Record<string, unknown> {
  const t = (text ?? '').trim();
  if (!t) return {};
  let v: unknown;
  try { v = JSON.parse(t); } catch (e) { throw new Error(`Extra request parameters are not valid JSON: ${(e as Error).message}`); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Extra request parameters must be a JSON object, like {"temperature": 0.2}.');
  const bad = Object.keys(v).filter((k) => RESERVED_BODY.includes(k));
  if (bad.length) throw new Error(`Extra request parameters cannot set ${bad.join(', ')} (the assistant controls these).`);
  return v as Record<string, unknown>;
}
