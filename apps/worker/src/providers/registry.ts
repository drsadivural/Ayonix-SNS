// Platform → adapter lookup. Adapters report configured()/capabilities
// themselves; presence in this map does not mean a network is enabled.
import type { Platform } from '@ayonix/contracts';
import { facebook } from './facebook.js';
import { instagram } from './instagram.js';
import { linkedin } from './linkedin.js';
import { tiktok } from './tiktok.js';
import type { ProviderAdapter } from './types.js';
import { youtube } from './youtube.js';

export const adapters: Record<Platform, ProviderAdapter> = { linkedin, facebook, instagram, tiktok, youtube };

export function adapterFor(p: Platform): ProviderAdapter {
  const a = adapters[p];
  if (!a) throw new Error(`No adapter for platform ${String(p)}`);
  return a;
}
