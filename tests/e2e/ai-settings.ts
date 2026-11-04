// Shared steps for the e2e scripts: fill Edit > AI Assistant Settings (General, API keys, Models & tiers) on screen with
// one provider and one tier, as a user would. The dialog must be open.
import type { Page } from 'playwright';

export async function fillOneProvider(win: Page, o: { preset?: string; url: string; model: string; key?: string; headers?: string; body?: string }): Promise<void> {
  await win.locator('.dialog input[type=checkbox]').first().check();
  await win.click('.dialog .tab:has-text("API keys")');
  if (!(await win.locator('.dialog fieldset').count())) await win.click('.dialog button:has-text("Add a provider")');
  const f = win.locator('.dialog fieldset').first();
  await f.locator('select').first().selectOption(o.preset ?? 'LM Studio (local)');
  await f.locator('input[placeholder="https://..."]').fill(o.url);
  if (o.key) await f.locator('input[type=password]').fill(o.key);
  if (o.headers != null) await f.locator('textarea').nth(0).fill(o.headers);
  if (o.body != null) await f.locator('textarea').nth(1).fill(o.body);
  await win.click('.dialog .tab:has-text("Models & tiers")');
  if (!(await win.locator('.dialog .tbl tbody tr').count())) await win.click('.dialog button:has-text("Add a tier")');
  await win.locator('.dialog .tbl tbody tr').first().locator('input').nth(1).fill(o.model);
}
