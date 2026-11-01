// CONTRACT TEST with a fetch double. Not live provider evidence (docs/10-ACCEPTANCE.md).
import { describe, expect, it } from 'vitest';
import { PLATFORMS } from '@ayonix/contracts';
import { chunkStream } from '../../../apps/worker/src/providers/common.js';
import { adapterFor, adapters } from '../../../apps/worker/src/providers/registry.js';
import { env, media } from './helpers.js';

describe('provider registry', () => {
  it('has exactly one adapter per platform, keyed by its provider', () => {
    expect(Object.keys(adapters).sort()).toEqual([...PLATFORMS].sort());
    for (const p of PLATFORMS) expect(adapterFor(p).provider).toBe(p);
  });

  it('configured() reflects operator configuration only', () => {
    for (const p of PLATFORMS) expect(adapterFor(p).configured(env)).toBe(true);
    const bare = { ...env, LINKEDIN_API_VERSION: undefined, META_APP_SECRET: undefined, TIKTOK_CLIENT_SECRET: undefined, GOOGLE_CLIENT_SECRET: undefined } as typeof env;
    for (const p of PLATFORMS) expect(adapterFor(p).configured(bare)).toBe(false);
  });
});

describe('chunkStream', () => {
  it('re-chunks a stream into exact sizes and rejects size mismatches', async () => {
    const out: number[] = [];
    for await (const c of chunkStream(await media({ bytes: 10 }).open(), [3, 3, 4])) out.push(c.byteLength);
    expect(out).toEqual([3, 3, 4]);
    const drain = async (sizes: number[]) => {
      for await (const _ of chunkStream(await media({ bytes: 10 }).open(), sizes)) void _;
    };
    await expect(drain([4, 4])).rejects.toMatchObject({ code: 'media_size_mismatch' });
    await expect(drain([6, 6])).rejects.toMatchObject({ code: 'media_size_mismatch' });
  });
});
