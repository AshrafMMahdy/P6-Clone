// The embedded platform agent's model setup (its LLM Router config, llm-router.json) built from the app's AI settings,
// in the platform's own terms: providers, an ordered list of model tiers (strongest first: the ladder the agent hands
// work up and dispatches Researchers and handovers along) and seats pointing at tiers (the agent, Reviewer = skeptic,
// Advisor = senior_guidance, Researchers, fast retrieval, vision / OCR as the agent's eyes, ...). A seat left unset sits
// on the agent's tier (the agent's own, unset, on the first), so one provider and one model are enough to start. The
// Handover seat is no router seat: it names the tier a handover with no tier goes to (agent env WHIQ_HANDOVER_TIER).
// API keys never go into the file: each provider names an environment variable (apiKeyEnv) that only the router child
// process receives, decrypted in the main process.
export type ProviderType = 'anthropic' | 'openai-compat' | 'gemini';
export interface AgentProvider { name: string; type: ProviderType; baseUrl: string; key: string }
export interface Tier { name: string; provider: string; model: string; params?: Record<string, unknown>; description?: string }
/** Seats that hold a chat model (platform router roles): the agent, its sub-agents' seats and helpers. */
export const CHAT_SEATS = ['agent', 'research', 'skeptic', 'senior_guidance', 'fast_retrieve', 'vision_ocr', 'ocr_locator', 'autopilot', 'extract', 'decide'] as const;
/** Seats that need a model of their own kind (embeddings, speech, search): only set when the user gives one. */
export const SERVICE_SEATS = ['embedding', 'stt', 'reranker', 'web_search'] as const;
export type Seat = (typeof CHAT_SEATS)[number] | (typeof SERVICE_SEATS)[number] | 'handover';
export interface AgentModels {
  providers: AgentProvider[];
  /** strongest first */
  tiers: Tier[];
  /** seat -> tier name; a chat seat not listed sits on the agent's tier, a service seat not listed is off */
  seats?: Partial<Record<Seat, string>>;
}

const envOf = (i: number) => `P6CLONE_PROVIDER_${i}_KEY`;

/** The router config, the environment its child process needs (keys) and the agent server's (the Handover seat). */
export function routerConfig(m: AgentModels): { config: Record<string, unknown>; env: Record<string, string>; agentEnv: Record<string, string> } {
  if (!m.providers.length) throw new Error('No AI provider is set up.');
  if (!m.tiers.length) throw new Error('No model tier is set up.');
  const names = new Set(m.providers.map((p) => p.name));
  const env: Record<string, string> = {};
  const providers: Record<string, unknown> = {};
  m.providers.forEach((p, i) => {
    providers[p.name] = { type: p.type, baseUrl: p.baseUrl, apiKeyEnv: envOf(i) };
    if (p.key) env[envOf(i)] = p.key;
  });
  const tiers: Record<string, unknown> = {};
  for (const t of m.tiers) {
    if (!names.has(t.provider)) throw new Error(`Tier "${t.name}": no provider "${t.provider}".`);
    if (!t.model) throw new Error(`Tier "${t.name}": no model.`);
    if (tiers[t.name]) throw new Error(`Two tiers are named "${t.name}".`);
    tiers[t.name] = { provider: t.provider, model: t.model, params: t.params ?? {}, description: t.description ?? '' };
  }
  const agentTier = m.seats?.agent ?? m.tiers[0].name;
  const seatTier = (seat: Seat): string | undefined => {
    const t = m.seats?.[seat];
    if (t != null && !tiers[t]) throw new Error(`Seat "${seat}": no tier "${t}".`);
    return t ?? ((CHAT_SEATS as readonly string[]).includes(seat) ? agentTier : undefined);
  };
  // the scheduler module maps each seat to its tier; the flat roles carry the same (the router falls back to them)
  const scheduler: Record<string, string> = {}, roles: Record<string, unknown> = {};
  for (const seat of [...CHAT_SEATS, ...SERVICE_SEATS]) {
    const t = seatTier(seat);
    if (!t) continue;
    scheduler[seat] = t;
    const { description: _d, ...entry } = tiers[t] as Record<string, unknown>;
    roles[seat] = entry;
  }
  const handover = seatTier('handover');
  return { config: { providers, roles, matchSkepticToAgent: false, tiers, tierOrder: m.tiers.map((t) => t.name), modules: { scheduler } }, env, agentEnv: handover ? { WHIQ_HANDOVER_TIER: handover } : {} };
}
