// Tested, dependency-free business rules. This is not a publishing server.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const catalog = JSON.parse(readFileSync(new URL('../contracts/pricing.json', import.meta.url), 'utf8'));
const has = (obj, key) => Object.hasOwn(obj, key);
function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${label} must be a safe integer >= ${minimum}`);
  return value;
}
function exactKeys(obj, allowed) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new TypeError('Expected object');
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) throw new TypeError(`Unknown field: ${key}`);
}

export function customQuote(selection = {}) {
  const fields = ['posts', 'products', ...Object.keys(catalog.custom.features)];
  exactKeys(selection, fields);
  const normalized = {posts: 20, products: 1, autoLearn: false, competitorCheck: false, similarResearch: false, ...selection};
  integer(normalized.posts, 'posts', 1);
  integer(normalized.products, 'products', 1);
  const c = catalog.custom;
  if (!has(c.postTiers, normalized.posts) || !has(c.productTiers, normalized.products)) throw new RangeError('Unsupported capacity tier');
  let priceCents = c.baseCents + c.postTiers[normalized.posts] + c.productTiers[normalized.products];
  for (const [feature, amount] of Object.entries(c.features)) {
    if (typeof normalized[feature] !== 'boolean') throw new TypeError(`${feature} must be boolean`);
    if (normalized[feature]) priceCents += amount;
  }
  if (priceCents > c.maximumCents) throw new RangeError('Catalog exceeds maximum');
  const quote = {catalogVersion: catalog.version, currency: catalog.currency, interval: catalog.interval, priceCents, selection: normalized};
  // Identity hash only; NOT an authorization token. Server must sign expiring quotes.
  const configurationHash = createHash('sha256').update(JSON.stringify(quote)).digest('hex');
  return {...quote, configurationHash};
}

export function standardPlan(name) {
  if (!has(catalog.plans, name)) throw new RangeError('Unknown plan');
  return {...catalog.plans[name]};
}

export function reserveQuota({allowance, used, reserved}, targets) {
  [allowance, used, reserved].forEach((v, i) => integer(v, ['allowance', 'used', 'reserved'][i]));
  integer(targets, 'targets', 1);
  if (used + reserved > allowance) throw new RangeError('Invalid quota state');
  if (targets > allowance - used - reserved) throw new RangeError('Quota exceeded');
  return {allowance, used, reserved: reserved + targets};
}

export function settleReservation(quota, outcome) {
  const {allowance, used, reserved} = quota;
  [allowance, used, reserved].forEach((v, i) => integer(v, ['allowance', 'used', 'reserved'][i]));
  if (used + reserved > allowance || reserved < 1) throw new RangeError('No valid reservation');
  if (outcome === 'unknown') return {...quota};
  if (outcome === 'published') return {allowance, used: used + 1, reserved: reserved - 1};
  if (outcome === 'definite_failure' || outcome === 'canceled_before_submission') return {allowance, used, reserved: reserved - 1};
  throw new RangeError('Unsupported settlement');
}

const transitions = {
  draft: ['awaiting_approval', 'canceled'],
  awaiting_approval: ['scheduled', 'draft', 'canceled'],
  scheduled: ['queued', 'canceled', 'awaiting_approval', 'reconnect_required'],
  queued: ['submitting', 'canceled', 'reconnect_required'],
  submitting: ['processing', 'published', 'retry_wait', 'failed', 'outcome_unknown', 'reconnect_required'],
  processing: ['published', 'failed', 'outcome_unknown', 'reconnect_required'],
  retry_wait: ['queued', 'canceled', 'reconnect_required'],
  reconnect_required: ['awaiting_approval', 'canceled', 'outcome_unknown'],
  outcome_unknown: ['published', 'failed'],
  published: [], failed: [], canceled: []
};
export function transition(current, next) {
  if (!has(transitions, current) || !transitions[current].includes(next)) throw new RangeError(`Illegal transition ${current} -> ${next}`);
  return next;
}

export function validateSchedule({utc, timezone}, now = new Date()) {
  if (typeof utc !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(utc)) throw new TypeError('An explicit UTC timestamp is required');
  const date = new Date(utc);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(now.getTime())) throw new TypeError('Invalid date');
  if (date.toISOString().replace('.000Z', 'Z') !== utc.replace('.000Z', 'Z')) throw new TypeError('Invalid calendar timestamp');
  if (typeof timezone !== 'string' || !timezone) throw new TypeError('IANA timezone required');
  new Intl.DateTimeFormat('en', {timeZone: timezone}).format(date);
  if (date <= now) throw new RangeError('Schedule must be in the future');
  return {utc: date.toISOString(), timezone};
}

export function validateTargets(targets) {
  if (!Array.isArray(targets) || !targets.length || targets.length > 1000) throw new TypeError('1–1000 targets required');
  const platforms = ['linkedin', 'facebook', 'instagram', 'tiktok', 'youtube'];
  const seen = new Set();
  for (const target of targets) {
    exactKeys(target, ['platform', 'connectionId', 'format', 'hasMedia']);
    if (!platforms.includes(target.platform)) throw new RangeError('Unsupported platform');
    if (typeof target.connectionId !== 'string' || !target.connectionId.trim()) throw new TypeError('Connection ID required');
    if (typeof target.hasMedia !== 'boolean') throw new TypeError('hasMedia must be boolean');
    const formats = {
      linkedin: ['text', 'link', 'image', 'video'], facebook: ['text', 'link', 'image', 'video', 'reel'],
      instagram: ['image', 'carousel', 'reel'], tiktok: ['photo', 'video'], youtube: ['video']
    };
    if (!formats[target.platform].includes(target.format)) throw new RangeError('Unsupported platform format');
    if (!['text', 'link'].includes(target.format) && !target.hasMedia) throw new RangeError('Media required');
    const key = `${target.platform}:${target.connectionId}`;
    if (seen.has(key)) throw new RangeError('Duplicate destination');
    seen.add(key);
  }
  // Account ownership, approved scopes, media constraints and creator consent
  // are separate server checks. This only validates generic intent shape.
  return targets.length;
}
