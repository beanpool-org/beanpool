import { formatCount } from '@beanpool/core';

export interface VoucherHistoryLine {
    kind: string;
    amount: number;
    actor: string;
    actorCallsign: string | null;
    at: string;
    for?: 'invite' | 'profile';
    inviteMadeAt?: string | null;
    outcome?: 'held' | 'vouched' | 'back';
    why?: 'expired' | 'stopped' | 'not_landed';
    person?: { memberPubkey: string; callsign: string } | null;
}

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
    const amount = formatCount(Math.abs(h.amount));
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

/** Header line for the voucher panel: "Voucher · 550 of 1,000 left · made from the names list" (or "by role"). */
export function voucherPanelHeader(card: { left: number; level?: number; source?: string | null }): string {
    const leftStr = formatCount(card.left);
    const levelStr = formatCount(card.level ?? 1000);
    const sourceStr = card.source === 'role' ? 'by role' : 'made from the names list';
    return `Voucher · ${leftStr} of ${levelStr} left · ${sourceStr}`;
}
