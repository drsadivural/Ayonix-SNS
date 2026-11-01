// Per-workspace coordinator. Every schedule mutation and dispatch claim /
// settlement for a workspace runs here one at a time (blockConcurrencyWhile),
// with D1 compare-and-swap + fencing tokens as the durable guard.
import { DurableObject } from 'cloudflare:workers';
import type { Env, QueueMessage } from '../lib/env.js';
import { AppError } from '../lib/errors.js';
import type { Actor } from '../services/context.js';
import { cancelSchedule, confirmSchedule, releaseAndCancelStatements, rescheduleTarget, resolveUnknown } from '../services/schedules.js';
import { approvalContext, returnToDraft, submitApproval, type TikTokApprovalInput } from '../services/approvals.js';
import { ensureFreshTokens } from '../services/connections.js';
import type { ProviderContext } from '../providers/types.js';
import { auditStmt } from '../services/audit.js';
import { applySettlement, claimForDispatch, claimPoll, loadTarget, type ClaimResult, type Settlement } from './dispatch.js';

type Op =
  | { op: 'confirm'; actor: Actor; input: { preview_token: string; confirmed: boolean; idempotency_key: string } }
  | { op: 'cancel'; actor: Actor; input: { schedule_id: string; expected_version: number; idempotency_key: string } }
  | { op: 'reschedule'; actor: Actor; targetId: string; input: { expected_version: number; scheduled_at_utc: string; timezone: string } }
  | { op: 'resolve'; actor: Actor; targetId: string; input: { expected_version: number; outcome: 'not_published' | 'published'; provider_url?: string; provider_post_id?: string } }
  | { op: 'approval_context'; actor: Actor; targetId: string }
  | { op: 'approve'; actor: Actor; targetId: string; input: TikTokApprovalInput }
  | { op: 'return_to_draft'; actor: Actor; targetId: string };

export type SerializedError = { __error: true; code: AppError['code']; message: string; extra: AppError['extra'] };

export class WorkspaceCoordinator extends DurableObject<Env> {
  /**
   * Run one operation at a time. Errors are captured inside the callback:
   * a throwing blockConcurrencyWhile callback would reset the object.
   */
  private async serial<T>(fn: () => Promise<T>): Promise<T> {
    const r = await this.ctx.blockConcurrencyWhile(async () => {
      try {
        return { ok: true as const, value: await fn() };
      } catch (error) {
        return { ok: false as const, error };
      }
    });
    if (!r.ok) throw r.error;
    return r.value;
  }

  /** Service mutations; AppErrors are returned as data so they survive RPC. */
  async mutate(op: Op): Promise<unknown> {
    try {
      return await this.serial(async () => {
        const env = this.env;
        switch (op.op) {
          case 'confirm':
            return confirmSchedule(env, op.actor, op.input);
          case 'cancel':
            return cancelSchedule(env, op.actor, op.input);
          case 'reschedule':
            return rescheduleTarget(env, op.actor, op.targetId, op.input);
          case 'resolve':
            return resolveUnknown(env, op.actor, op.targetId, op.input);
          case 'approval_context':
            return approvalContext(env, op.actor, op.targetId);
          case 'approve':
            return submitApproval(env, op.actor, op.targetId, op.input);
          case 'return_to_draft':
            return returnToDraft(env, op.actor, op.targetId);
        }
      });
    } catch (e) {
      if (e instanceof AppError) return { __error: true, code: e.code, message: e.message, extra: e.extra } satisfies SerializedError;
      throw e;
    }
  }

  async claim(msg: QueueMessage, owner: string): Promise<ClaimResult> {
    return this.serial(() => claimForDispatch(this.env, msg, owner));
  }

  async settle(workspaceId: string, targetId: string, fencing: number, s: Settlement, phase: 'submit' | 'poll' | 'reconcile') {
    return this.serial(() => applySettlement(this.env, workspaceId, targetId, fencing, s, phase));
  }

  async claimPoll(workspaceId: string, targetId: string, owner: string) {
    return this.serial(() => claimPoll(this.env, workspaceId, targetId, owner));
  }

  /** Single-flight token refresh for a connection in this workspace. */
  async refresh(ctxData: { workspaceId: string; connectionId: string; requestId: string }): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.serial(async () => {
      const { providerContext } = await import('../services/connections.js');
      try {
        await ensureFreshTokens(this.env, await providerContext(this.env, ctxData.workspaceId, ctxData.connectionId, ctxData.requestId), ctxData.requestId);
        return { ok: true as const };
      } catch (e) {
        return { ok: false as const, reason: e instanceof Error ? e.message : 'refresh failed' };
      }
    });
  }

  /** Complete a native YouTube cancellation after the provider confirmed removal. */
  async nativeCanceled(workspaceId: string, targetId: string) {
    return this.serial(async () => {
      const t = await loadTarget(this.env, workspaceId, targetId);
      if (!t || t.status !== 'processing') return 'stale';
      await this.env.DB.batch([
        ...releaseAndCancelStatements(this.env, workspaceId, targetId, t.version, t.period_id, 'canceled', null, null),
        auditStmt(this.env, { workspaceId, actorType: 'system', requestId: `native-cancel:${targetId}` }, 'target.native_canceled', 'target', targetId),
      ]);
      return 'canceled';
    });
  }
}

export function coordinator(env: Env, workspaceId: string) {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName(workspaceId)) as unknown as DurableObjectStub<WorkspaceCoordinator>;
}

/** Call a coordinator mutation and rethrow AppErrors on this side of the RPC boundary. */
export async function mutate<T>(env: Env, workspaceId: string, op: Op): Promise<T> {
  const result = (await coordinator(env, workspaceId).mutate(op)) as unknown;
  if (result && typeof result === 'object' && (result as SerializedError).__error) {
    const e = result as SerializedError;
    throw new AppError(e.code, e.message, e.extra);
  }
  return result as T;
}

/** Refresh helper used by queue execution: single-flight through the coordinator, then reload tokens. */
export function refresher(env: Env, workspaceId: string, requestId: string) {
  return async (ctx: ProviderContext): Promise<ProviderContext> => {
    if (!ctx.tokens.expiresAt || new Date(ctx.tokens.expiresAt).getTime() - Date.now() > 10 * 60_000) return ctx;
    const r = await coordinator(env, workspaceId).refresh({ workspaceId, connectionId: ctx.connection.id, requestId });
    const { providerContext } = await import('../services/connections.js');
    const fresh = await providerContext(env, workspaceId, ctx.connection.id, ctx.correlationId, ctx.fetch);
    if (!r.ok && (!fresh.tokens.expiresAt || new Date(fresh.tokens.expiresAt).getTime() < Date.now())) {
      const { ProviderError } = await import('../providers/types.js');
      throw new ProviderError('reconnect_required', 'token_expired', r.reason);
    }
    return fresh;
  };
}
