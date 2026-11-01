import { describe, expect, it } from 'vitest';
import { TARGET_STATES } from '@ayonix/contracts';
import { CONNECTION_STATE_INFO, TARGET_STATE_INFO } from './labels';

describe('target state labels', () => {
  it('has a plain-language label and description for every TargetState', () => {
    expect(Object.keys(TARGET_STATE_INFO).sort()).toEqual([...TARGET_STATES].sort());
    for (const state of TARGET_STATES) {
      const info = TARGET_STATE_INFO[state];
      expect(info.label.trim().length).toBeGreaterThan(0);
      expect(info.description.trim().length).toBeGreaterThan(0);
      expect(info.label).not.toContain('_');
    }
  });

  it('gives every state a distinct label', () => {
    const labels = TARGET_STATES.map((s) => TARGET_STATE_INFO[s].label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('never calls processing published', () => {
    expect(TARGET_STATE_INFO.processing.label).not.toMatch(/published/i);
    expect(TARGET_STATE_INFO.processing.description).toMatch(/not published/i);
  });

  it('labels every connection state', () => {
    for (const s of ['disconnected', 'authorizing', 'pending_review', 'connected', 'expiring', 'reconnect_required', 'restricted', 'error'] as const) {
      expect(CONNECTION_STATE_INFO[s].label.length).toBeGreaterThan(0);
    }
  });
});
