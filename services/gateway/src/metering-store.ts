/**
 * Credit reservations for streaming chat. Before a stream starts, the worst-case cost is held (moved out of the
 * balance); when it ends, the actual cost is charged and the rest refunded. A turn that starts with plan/pack actions
 * available consumes ONE action, which covers up to ACTION_CREDIT_ALLOWANCE credits of usage for that turnId; usage
 * beyond the allowance is paid from credits.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { GatewayConfig } from './config.ts';
import { audit, getAccount, tx, type Row } from './db.ts';
import { periodKey } from './metering.ts';

export interface Hold { id: string; accountId: string; turnId: string | null; fromAllowance: number; fromCredits: number; actionConsumed: boolean }
export type ReserveResult = { ok: true; hold: Hold } | { ok: false; available: number; required: number };

export function reserve(db: DatabaseSync, config: GatewayConfig, accountId: string, turnId: string | null, required: number, now = Date.now()): ReserveResult {
  return tx(db, () => {
    const account = getAccount(db, accountId);
    if (!account) return { ok: false, available: 0, required };
    const turn = turnId ? db.prepare('SELECT allowance_left FROM turns WHERE account_id = ? AND turn_id = ?').get(accountId, turnId) as Row | undefined : undefined;
    const consumeAction = !!turnId && !turn && account.plan_actions + account.pack_actions > 0 && config.actionCreditAllowance > 0;
    const allowance = turn ? Number(turn.allowance_left) : consumeAction ? config.actionCreditAllowance : 0;
    if (allowance + account.credits < required) {
      audit(db, accountId, 'chat.refused_balance', { required, available: allowance + account.credits });
      return { ok: false, available: allowance + account.credits, required };
    }
    const fromAllowance = Math.min(required, allowance), fromCredits = required - fromAllowance;
    if (consumeAction) {
      db.prepare(account.plan_actions > 0 ? 'UPDATE accounts SET plan_actions = plan_actions - 1 WHERE id = ?' : 'UPDATE accounts SET pack_actions = pack_actions - 1 WHERE id = ?').run(accountId);
      db.prepare('INSERT INTO turns (account_id, turn_id, allowance_left, created_at) VALUES (?, ?, ?, ?)').run(accountId, turnId, allowance - fromAllowance, now);
      db.prepare('INSERT INTO usage (account_id, period, credits, actions, request_id, created_at) VALUES (?, ?, 0, 1, ?, ?)').run(accountId, periodKey(new Date(now)), turnId, now);
    } else if (turn && fromAllowance) {
      db.prepare('UPDATE turns SET allowance_left = allowance_left - ? WHERE account_id = ? AND turn_id = ?').run(fromAllowance, accountId, turnId);
    }
    if (fromCredits) db.prepare('UPDATE accounts SET credits = credits - ? WHERE id = ?').run(fromCredits, accountId);
    const hold: Hold = { id: randomUUID(), accountId, turnId: (consumeAction || turn) ? turnId : null, fromAllowance, fromCredits, actionConsumed: consumeAction };
    db.prepare('INSERT INTO holds (id, account_id, turn_id, from_allowance, from_credits, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(hold.id, accountId, hold.turnId, fromAllowance, fromCredits, now);
    return { ok: true, hold };
  });
}

/** Charges `actual` credits against a hold, refunds the remainder, records usage. Returns credits taken from the balance. */
export function settle(db: DatabaseSync, hold: Hold, actual: number, detail: { model: string; inputTokens: number; outputTokens: number; requestId: string }, now = Date.now()): number {
  return tx(db, () => {
    if (!db.prepare('SELECT 1 FROM holds WHERE id = ?').get(hold.id)) return 0;
    const useAllowance = Math.min(actual, hold.fromAllowance);
    const useCredits = Math.min(actual - useAllowance, hold.fromCredits);
    const refund = hold.fromCredits - useCredits;
    let overflow = actual - useAllowance - useCredits;
    if (refund) db.prepare('UPDATE accounts SET credits = credits + ? WHERE id = ?').run(refund, hold.accountId);
    if (overflow > 0) {
      // The estimate was exceeded: take what is left on the balance, never below zero.
      const credits = getAccount(db, hold.accountId)?.credits ?? 0;
      overflow = Math.min(overflow, credits);
      db.prepare('UPDATE accounts SET credits = credits - ? WHERE id = ?').run(overflow, hold.accountId);
      audit(db, hold.accountId, 'chat.estimate_exceeded', { requestId: detail.requestId, actual });
    }
    if (hold.turnId && hold.fromAllowance - useAllowance > 0)
      db.prepare('UPDATE turns SET allowance_left = allowance_left + ? WHERE account_id = ? AND turn_id = ?').run(hold.fromAllowance - useAllowance, hold.accountId, hold.turnId);
    db.prepare('DELETE FROM holds WHERE id = ?').run(hold.id);
    const charged = useCredits + Math.max(0, overflow);
    db.prepare('INSERT INTO usage (account_id, period, credits, actions, model, input_tokens, output_tokens, request_id, created_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)')
      .run(hold.accountId, periodKey(new Date(now)), charged, detail.model, detail.inputTokens, detail.outputTokens, detail.requestId, now);
    audit(db, hold.accountId, 'chat.charged', { requestId: detail.requestId, model: detail.model, credits: charged, allowance: useAllowance, inputTokens: detail.inputTokens, outputTokens: detail.outputTokens });
    return charged;
  });
}

/** After a crash, holds left behind are refunded in full (the reference favors the customer). */
export function releaseStaleHolds(db: DatabaseSync): number {
  return tx(db, () => {
    const rows = db.prepare('SELECT * FROM holds').all() as Row[];
    for (const row of rows) {
      db.prepare('UPDATE accounts SET credits = credits + ? WHERE id = ?').run(Number(row.from_credits), row.account_id as string);
      if (row.turn_id) db.prepare('UPDATE turns SET allowance_left = allowance_left + ? WHERE account_id = ? AND turn_id = ?').run(Number(row.from_allowance), row.account_id as string, row.turn_id as string);
      db.prepare('DELETE FROM holds WHERE id = ?').run(row.id as string);
      audit(db, row.account_id as string, 'chat.hold_released', { hold: row.id });
    }
    return rows.length;
  });
}
