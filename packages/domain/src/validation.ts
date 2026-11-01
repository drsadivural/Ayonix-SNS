import { PLATFORMS, type Platform, type PostFormat } from '@ayonix/contracts';

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Generic organic formats per network. Account capability is a separate gate. */
export const PLATFORM_FORMATS: Record<Platform, readonly PostFormat[]> = {
  linkedin: ['text', 'link', 'image', 'video'],
  facebook: ['text', 'link', 'image', 'video', 'reel'],
  instagram: ['image', 'carousel', 'reel'],
  tiktok: ['photo', 'video'],
  youtube: ['video'],
};

export const MEDIA_RULES: Record<PostFormat, { min: number; max: number; kinds: Array<'image' | 'video'> }> = {
  text: { min: 0, max: 0, kinds: [] },
  link: { min: 0, max: 0, kinds: [] },
  image: { min: 1, max: 20, kinds: ['image'] },
  photo: { min: 1, max: 35, kinds: ['image'] },
  carousel: { min: 2, max: 10, kinds: ['image', 'video'] },
  video: { min: 1, max: 1, kinds: ['video'] },
  reel: { min: 1, max: 1, kinds: ['video'] },
};

export const CAPTION_LIMITS: Record<Platform, number> = {
  linkedin: 3000,
  facebook: 63206,
  instagram: 2200,
  tiktok: 2200,
  youtube: 5000,
};

export interface TargetIntent {
  platform: string;
  connectionId: string;
  format: string;
  hasMedia: boolean;
}

/** Validates generic intent shape (ported from the handoff reference). */
export function validateTargets(targets: unknown): number {
  if (!Array.isArray(targets) || !targets.length || targets.length > 1000) {
    throw new ValidationError('1–1000 targets required');
  }
  const seen = new Set<string>();
  for (const raw of targets) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('Expected object');
    for (const key of Object.keys(raw)) {
      if (!['platform', 'connectionId', 'format', 'hasMedia'].includes(key)) throw new ValidationError(`Unknown field: ${key}`);
    }
    const t = raw as TargetIntent;
    if (!(PLATFORMS as readonly string[]).includes(t.platform)) throw new ValidationError('Unsupported platform');
    if (typeof t.connectionId !== 'string' || !t.connectionId.trim()) throw new ValidationError('Connection ID required');
    if (typeof t.hasMedia !== 'boolean') throw new ValidationError('hasMedia must be boolean');
    if (!PLATFORM_FORMATS[t.platform as Platform].includes(t.format as PostFormat)) {
      throw new ValidationError('Unsupported platform format');
    }
    if (!['text', 'link'].includes(t.format) && !t.hasMedia) throw new ValidationError('Media required');
    const key = `${t.platform}:${t.connectionId}`;
    if (seen.has(key)) throw new ValidationError('Duplicate destination');
    seen.add(key);
  }
  return targets.length;
}

export interface DestinationCheckInput {
  platform: Platform;
  format: PostFormat;
  caption: string;
  title?: string | undefined;
  link_url?: string | undefined;
  assets: Array<{ mime: string; validation_state: string; duration_ms: number | null; width: number | null; height: number | null }>;
}

/** Returns human-readable problems; empty array means the destination is valid. */
export function destinationProblems(d: DestinationCheckInput): string[] {
  const problems: string[] = [];
  const formats = PLATFORM_FORMATS[d.platform];
  if (!formats.includes(d.format)) {
    problems.push(`${d.platform} does not support the ${d.format} format. Supported: ${formats.join(', ')}.`);
    return problems;
  }
  if (d.caption.length > CAPTION_LIMITS[d.platform]) {
    problems.push(`Caption exceeds ${CAPTION_LIMITS[d.platform]} characters for ${d.platform}.`);
  }
  const rule = MEDIA_RULES[d.format];
  if (d.assets.length < rule.min || d.assets.length > rule.max) {
    problems.push(
      rule.max === 0
        ? `The ${d.format} format cannot carry media.`
        : `The ${d.format} format needs ${rule.min === rule.max ? rule.min : `${rule.min}–${rule.max}`} media item(s).`,
    );
  }
  for (const a of d.assets) {
    if (a.validation_state !== 'valid') problems.push('Every media item must finish validation first.');
    const kind = a.mime.startsWith('image/') ? 'image' : a.mime.startsWith('video/') ? 'video' : null;
    if (!kind || !rule.kinds.includes(kind)) problems.push(`${a.mime} is not allowed for the ${d.format} format.`);
  }
  if (d.format === 'link') {
    if (!d.link_url) problems.push('A link post needs a link URL.');
    else if (!/^https:\/\//.test(d.link_url)) problems.push('Link URL must use https.');
  }
  if (d.platform === 'youtube') {
    if (!d.title?.trim()) problems.push('YouTube needs a title.');
    else if (d.title.length > 100) problems.push('YouTube titles are limited to 100 characters.');
  }
  if (d.platform === 'instagram' && d.format === 'reel') {
    for (const a of d.assets) if (a.duration_ms !== null && a.duration_ms > 15 * 60_000) problems.push('Instagram Reels must be 15 minutes or shorter.');
  }
  if (d.platform === 'linkedin' && d.format === 'text' && !d.caption.trim()) problems.push('A LinkedIn text post needs text.');
  if (d.platform === 'facebook' && d.format === 'text' && !d.caption.trim()) problems.push('A Facebook text post needs text.');
  return [...new Set(problems)];
}
