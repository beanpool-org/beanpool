/**
 * Community health on an admin's phone (community modes slice 6; apps/server engine/community-health.ts). The node
 * answers the exceptions by member key and names-list entry id, never a name: the name is overlaid here, from the
 * names list this phone has opened and decrypted. Every opening of the exceptions is in a log every admin can read.
 */
import type { OpenedEntry } from './names-list';

export type HealthReason = 'past_debt_line' | 'quiet_in_debit';

export interface HealthException {
    memberPubkey: string;
    entryId: string;
    balance: number;
    floor: number;
    reasons: HealthReason[];
    lastSaleAt: string | null;
}

/** An open debt a member left behind (#1597), by the entry id of their names-list entry. */
export interface DepartedDebt {
    id: string;
    entryId: string | null;
    amount: number;
    reason: 'removed' | 'account_deleted';
    removedAt: string;
    repaid: number;
    repaying: boolean;
}

export interface HealthExceptionsBody {
    settings: { debtLinePct: number; quietDays: number };
    exceptions: HealthException[];
    departed: DepartedDebt[];
}

export interface HealthLogLine {
    id: string;
    actor: string;
    actorCallsign: string | null;
    action: string;
    at: string;
}

/** One row as the admin sees it: the name from the decrypted list, never from the node. */
export interface HealthRow {
    key: string;
    name: string;
    detail: string;
}

/** A name only this phone can give: the entry it opened, or a plain word where it couldn't open that entry. */
export function nameFor(entryId: string | null, entries: Pick<OpenedEntry, 'id' | 'text'>[]): string {
    const e = entryId ? entries.find((x) => x.id === entryId) : undefined;
    return e?.text?.name?.trim() || 'A name this phone can’t open';
}

const beans = (n: number) => `${Math.round(n * 100) / 100} Beans`;

export function reasonText(r: HealthReason, settings: HealthExceptionsBody['settings']): string {
    return r === 'past_debt_line'
        ? `past ${settings.debtLinePct}% of their floor`
        : `in debit with no sale for ${settings.quietDays} days`;
}

export function exceptionRows(body: HealthExceptionsBody, entries: Pick<OpenedEntry, 'id' | 'text'>[]): HealthRow[] {
    return body.exceptions.map((e) => ({
        key: e.memberPubkey,
        name: nameFor(e.entryId, entries),
        detail: `${beans(e.balance)} of a ${beans(e.floor)} floor · ${e.reasons.map((r) => reasonText(r, body.settings)).join(', and ')}`,
    }));
}

export function departedRows(body: HealthExceptionsBody, entries: Pick<OpenedEntry, 'id' | 'text'>[]): HealthRow[] {
    return body.departed.map((d) => ({
        key: d.id,
        name: nameFor(d.entryId, entries),
        detail: `left owing ${beans(d.amount - d.repaid)}${d.repaid > 0 ? ` (${beans(d.repaid)} repaid)` : ''}${d.repaying ? ' · repaying' : ''}`,
    }));
}

export function healthLogText(l: HealthLogLine): string {
    const who = l.actorCallsign ? `@${l.actorCallsign}` : 'An admin';
    const when = new Date(l.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    return `${who} opened the exceptions · ${when}`;
}
