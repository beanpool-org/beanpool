import { VOUCHER_BUDGET_DEFAULT } from '@beanpool/core';
import { beansFigure } from './beans';

/**
 * One line of a voucher's budget history, as GET /api/local/admin/known-floor/vouchers/member/:pubkey sends it (server
 * engine/vouchers.ts historyOf): `amount_c` whole hundredths of a Bean, signed as the allocation ledger keeps it.
 */
export interface VoucherHistoryLine {
    kind: string;
    amount_c: number;
    actor: string;
    actorCallsign: string | null;
    at: string;
    for?: 'invite' | 'profile';
    inviteMadeAt?: string | null;
    outcome?: 'held' | 'vouched' | 'back';
    why?: 'expired' | 'stopped' | 'not_landed';
    person?: { memberPubkey: string; callsign: string } | null;
}

/**
 * A voucher's card (server engine/vouchers.ts readVoucherCard): its budget figures keep their names (left, level, held,
 * vouched) and are whole hundredths of a Bean, like every voucher budget figure.
 */
export interface VoucherCard {
    memberPubkey: string;
    callsign: string;
    source: 'role' | 'entry' | string | null;
    left: number;
    level: number;
    held: number;
    vouched: number;
    history: VoucherHistoryLine[];
    people?: unknown[];
    canChange?: boolean;
}

const HEX_KEY = /^[0-9a-f]{64}$/i;

/**
 * Words for whoever made an allocation line or appointed a voucher. A member with a callsign is @callsign. The node's own
 * actors (engine/vouchers.ts, recover-command.ts) have words: `node:claim` (the first owner's grant, made by the claim
 * code), `server:recover` (the server's shell), `migration:vouchers` (the boot that gave every owner and admin a budget
 * when vouchers started), and `node` / `SYSTEM` (the community's server, e.g. an expired invite's return). A key whose
 * member row is gone comes back without a callsign: someone who has left. Nothing here ever prints a 64-hex key.
 */
export function voucherActorWords(line: { actor?: string | null; actorCallsign?: string | null }): string {
    if (line.actorCallsign) return `@${line.actorCallsign}`;
    const a = (line.actor ?? '').trim();
    if (a === 'node:claim' || a.startsWith('claim:')) return 'the community’s first owner';
    if (a.startsWith('server:')) return 'the server’s shell';
    if (a.startsWith('migration:')) return 'BeanPool, when vouchers started';
    if (!a || HEX_KEY.test(a)) return 'someone who has left';
    return 'the community’s server';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatHistoryDate(iso: string | null | undefined): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '';
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** One Budget history line in words (§3, V5: "+1,000 budget, made a voucher by @marty, 5 Nov · −100 held for an invite"). */
export function historyLineWords(h: VoucherHistoryLine): string {
    const date = formatHistoryDate(h.at);
    const datePart = date ? `, ${date}` : '';
    const actor = voucherActorWords(h);
    // Whole hundredths in words, without its sign (each kind says its own): 100000 is "1,000", 2550 is "25.50".
    const amount = beansFigure(typeof h.amount_c === 'number' ? Math.abs(h.amount_c) : h.amount_c);
    switch (h.kind) {
        case 'grant':
            return `+${amount} budget, made a voucher by ${actor}${datePart}`;
        case 'top_up':
            return `+${amount} top-up by ${actor}${datePart}`;
        case 'lower':
            return `−${amount} lower by ${actor}${datePart}`;
        case 'hold':
            return h.for === 'profile' && h.person
                ? `−${amount} held for @${h.person.callsign}${datePart}`
                : `−${amount} held for an invite${datePart}`;
        case 'return':
            if (h.why === 'expired') return `+${amount} back, invite expired${datePart}`;
            if (h.why === 'stopped') return `+${amount} back, budget stopped${datePart}`;
            if (h.why === 'not_landed') return `+${amount} back, vouch didn’t land${datePart}`;
            return `+${amount} back${datePart}`;
        case 'stop':
            return `Budget stopped by ${actor}${datePart}`;
        default:
            return `Budget changed by ${actor}${datePart}`;
    }
}

/**
 * Header line for the voucher panel: "Voucher · 550 of 1,000 left · made from the names list" (or "by role"). `left` and
 * `level` are whole hundredths (55000 of 100000); a card without a level reads the default budget (core
 * VOUCHER_BUDGET_DEFAULT, 1,000 Beans), as it always did.
 */
export function voucherPanelHeader(card: { left: number; level?: number; source?: string | null }): string {
    const leftStr = beansFigure(card.left);
    const levelStr = beansFigure(card.level ?? VOUCHER_BUDGET_DEFAULT);
    const sourceStr = card.source === 'role' ? 'by role' : 'made from the names list';
    return `Voucher · ${leftStr} of ${levelStr} left · ${sourceStr}`;
}
