// Free-form provider settings for the AI assistant: extra HTTP headers ("Name: value" per line) and extra request
// parameters (a JSON object merged into every request, e.g. temperature, top_p, max_tokens). No Node imports, so the
// settings dialog can validate with the same code.

/** Fields the assistant needs to work; extra parameters cannot replace them. */
export const RESERVED_BODY = ['messages', 'tools', 'system', 'tool_choice', 'stream'];

export function parseExtraHeaders(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [i, raw] of (text ?? '').split(/\r?\n/).entries()) {
    // tolerate what copy-paste and keyboards produce: invisible characters, typographic dashes, a full-width colon,
    // non-breaking spaces, "=" instead of ":", and spaces in the name (HTTP names cannot have them; they become dashes)
    const line = raw.replace(/[​-‍⁠﻿]/g, '').replace(/[‐-―−]/g, '-')
      .replace(/：/g, ':').replace(/[  -  　]/g, ' ').trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.search(/[:=]/);
    const name = sep > 0 ? line.slice(0, sep).trim().replace(/\s+/g, '-') : '';
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
      const odd = [...(sep > 0 ? name : line)].find((c) => !/[A-Za-z0-9!#$%&'*+.^_`|~-]/.test(c));
      throw new Error(`Extra headers, line ${i + 1}: write it as "Header-Name: value"${odd ? ` (the name contains "${odd}", U+${odd.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})` : ''}.`);
    }
    out[name] = line.slice(sep + 1).trim();
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
