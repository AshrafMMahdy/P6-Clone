// Free-form provider settings for the AI assistant: extra HTTP headers ("Name: value" per line) and extra request
// parameters (a JSON object merged into every request, e.g. max_tokens). No Node imports, so the
// settings dialog can validate with the same code.

/** Fields the assistant needs to work; extra parameters cannot replace them. */
export const RESERVED_BODY = ['messages', 'tools', 'system', 'tool_choice', 'stream'];
/** Sampling parameters the Claude API removed in version 2026-10-21: a request that sends one fails, at any value. */
// AGREED LIMIT (owner, 2026-11-28): temperature, top_p and top_k are refused for Anthropic (the dialog says why; a saved one is not sent) — why: item 26 rule 6, "Necessary limits - agreed" — necessary because API version 2026-10-21 refuses them.
export const ANTHROPIC_REMOVED_BODY = ['temperature', 'top_p', 'top_k'];

/** Whether a provider can search the web by itself (the router's web_search vendors that need no extra key): an Anthropic
 *  or Gemini provider, or an OpenRouter endpoint. The Web search seat, when unset, sits on the agent's tier if this holds. */
export function providerCanSearch(kind: string, baseUrl: string): boolean {
  return kind === 'anthropic' || kind === 'gemini' || /openrouter\.ai/i.test(baseUrl);
}

/** "Name: value" per line ('#' starts a comment). A line that is not that is refused, naming the line and the character that does
 *  not belong in a header name (an invisible one pasted in, a space, a typographic dash): it is never rewritten into another
 *  header (item 26, rule 1). provider 'anthropic': the workspace header has one name, anthropic-workspace-id. */
export function parseExtraHeaders(text: string | undefined, provider?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [i, raw] of (text ?? '').split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.indexOf(':');
    const name = sep > 0 ? line.slice(0, sep).trim() : '';
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
      const odd = [...(sep > 0 ? name : line)].find((c) => !/[A-Za-z0-9!#$%&'*+.^_`|~-]/.test(c));
      throw new Error(`Extra headers, line ${i + 1}: write it as "Header-Name: value"${odd ? ` (the name contains "${odd}", U+${odd.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}${/\s/.test(odd) ? ', a space' : ''})` : ''}.`);
    }
    // Anthropic reads a key's workspace from anthropic-workspace-id only (any letter case): another spelling is refused with that name
    if (provider === 'anthropic' && /workspace/i.test(name) && name.toLowerCase() !== 'anthropic-workspace-id') throw new Error(`Extra headers, line ${i + 1}: Anthropic does not read "${name}"; its workspace header is anthropic-workspace-id (write "anthropic-workspace-id: ${line.slice(sep + 1).trim()}").`);
    out[name] = line.slice(sep + 1).trim();
  }
  return out;
}

/** provider: 'anthropic' also refuses the sampling parameters that API no longer takes. */
export function parseExtraBody(text: string | undefined, provider?: 'anthropic' | 'openai'): Record<string, unknown> {
  const t = (text ?? '').trim();
  if (!t) return {};
  let v: unknown;
  try { v = JSON.parse(t); } catch (e) { throw new Error(`Extra request parameters are not valid JSON: ${(e as Error).message}`); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Extra request parameters must be a JSON object, like {"temperature": 0.2}.');
  const bad = Object.keys(v).filter((k) => RESERVED_BODY.includes(k));
  if (bad.length) throw new Error(`Extra request parameters cannot set ${bad.join(', ')} (the assistant controls these).`);
  const removed = provider === 'anthropic' ? Object.keys(v).filter((k) => ANTHROPIC_REMOVED_BODY.includes(k)) : [];
  if (removed.length) throw new Error(`Extra request parameters cannot set ${removed.join(', ')} for Anthropic: the Claude API removed them in version 2026-10-21, and a request that sends one fails. Remove ${removed.length > 1 ? 'them' : 'it'}.`);
  return v as Record<string, unknown>;
}
