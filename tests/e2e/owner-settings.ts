// The owner's own AI settings, for the real-model e2e scripts: copied into a test profile (the key stays encrypted;
// Chromium's "Local State" in AppData unlocks it on this Windows account). The settings live in the program's Data
// folder (main/dataPaths.ts): the packaged program's first, then a development run's, then the AppData layout of
// older versions; P6CLONE_OWNER_SETTINGS names the file outright.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const appData = join(process.env.APPDATA ?? '', 'p6-clone');

export function ownerSettings(): string | null {
  return [process.env.P6CLONE_OWNER_SETTINGS ?? '', join(root, 'release', 'P6 Clone', 'Data', 'Settings', 'ai-assistant.json'),
    join(root, 'Data', 'Settings', 'ai-assistant.json'), join(appData, 'ai-assistant.json')].find((f) => f && existsSync(f)) ?? null;
}

/** Copies the owner's settings into a test profile (made with --user-data); false when there are none. */
export function copyOwnerSettings(profile: string): boolean {
  const s = ownerSettings();
  if (!s) return false;
  mkdirSync(join(profile, 'Data', 'Settings'), { recursive: true });
  copyFileSync(s, join(profile, 'Data', 'Settings', 'ai-assistant.json'));
  if (existsSync(join(appData, 'Local State'))) copyFileSync(join(appData, 'Local State'), join(profile, 'Local State'));
  return true;
}
