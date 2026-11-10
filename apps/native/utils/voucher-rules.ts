/**
 * The phone's small voucher rules (slice V2; DESIGN-invites-and-names-list-amend2-fable.md §5, Marty's §10 and §11), in one
 * place so the names list, the voucher card and People → Invites call them and the tests can fail on them.
 *
 * None of this decides anything the node decides. Who is on the credit committee is the node's answer to
 * GET /api/names/vouchers (it answers only owners and committee admins); whether a level, a stop or an appointment stands is
 * engine/vouchers.ts's, and its refusal sentences are shown as they come. What is here only keeps the phone from OFFERING
 * what the node would refuse (a level off its 100-step grid, below held, above 2,000), and puts words on what it sends.
 */
import { t, formatDate, formatNumber, isBudgetLevel, VOUCHER_BUDGET_MIN, VOUCHER_BUDGET_MAX, VOUCHER_BUDGET_STEP, VOUCHER_BUDGET_DEFAULT } from '@beanpool/core';
import type { OpenedEntry, VoucherSummaryRow, VoucherHistoryLine, ConfirmationRow } from './names-list';

// ── Budget levels (§10: 100 to 2,000 in 100s, never below held; core's isBudgetLevel is the node's own check) ────────

/** The lowest level the node takes for a voucher holding `held` on unused invites: a step at or above it, and at least 100. */
export function lowestBudgetLevel(held: number): number {
    const h = Number.isFinite(held) && held > 0 ? held : 0;
    return Math.max(VOUCHER_BUDGET_MIN, Math.ceil(h / VOUCHER_BUDGET_STEP) * VOUCHER_BUDGET_STEP);
}

/**
 * Whether the node would take this level for this voucher: on the grid (isBudgetLevel: 100 to 2,000 in 100s; a level IS
 * left + held, so 2,000 is also the left + held ceiling) and not below what is held.
 */
export function acceptsBudgetLevel(level: number, held: number): boolean {
    return isBudgetLevel(level) && level >= lowestBudgetLevel(held);
}

/**
 * The nearest level the node takes, where a stepper starts. A card's `level` is left + held (budgetOf), and every landed
 * vouch lowers it, so it is often off the grid (1,000 given, 350 vouched: 650). Rounded to the nearest step, then kept
 * inside [lowest for held, 2,000]. Never the card's own number when that isn't a level.
 */
export function nearestBudgetLevel(level: number | null | undefined, held = 0): number {
    const from = typeof level === 'number' && Number.isFinite(level) ? level : VOUCHER_BUDGET_DEFAULT;
    const near = Math.round(from / VOUCHER_BUDGET_STEP) * VOUCHER_BUDGET_STEP;
    return Math.min(VOUCHER_BUDGET_MAX, Math.max(lowestBudgetLevel(held), near));
}

/** One step up from `level`, to the next level on the grid; null at the ceiling. */
export function budgetLevelUp(level: number, held = 0): number | null {
    const next = Math.max(lowestBudgetLevel(held), Math.ceil((level + 1) / VOUCHER_BUDGET_STEP) * VOUCHER_BUDGET_STEP);
    return next <= VOUCHER_BUDGET_MAX ? next : null;
}

/** One step down from `level`, to the next level on the grid; null at the floor (100, or held rounded up). */
export function budgetLevelDown(level: number, held = 0): number | null {
    const next = Math.min(VOUCHER_BUDGET_MAX, Math.floor((level - 1) / VOUCHER_BUDGET_STEP) * VOUCHER_BUDGET_STEP);
    return next >= lowestBudgetLevel(held) ? next : null;
}

// ── Who wrote a Budget history line (never a key or the node's own actor string) ─────────────────────────────────────

const HEX_KEY = /^[0-9a-f]{64}$/i;

/**
 * Words for whoever made an allocation line or appointed a voucher. A member with a callsign is @callsign. The node's own
 * actors (engine/vouchers.ts, recover-command.ts) have words: `node:claim` (the first owner's grant, made by the claim
 * code), `server:recover` (the server's shell), `migration:vouchers` (the boot that gave every owner and admin a budget
 * when vouchers started), and `node` / `SYSTEM` (the node itself, e.g. an expired invite's return). A key whose member row
 * is gone comes back without a callsign: someone who has left. Nothing here ever prints the actor string itself.
 */
export function voucherActorWords(line: { actor?: string | null; actorCallsign?: string | null }): string {
    if (line.actorCallsign) return `@${line.actorCallsign}`;
    const a = (line.actor ?? '').trim();
    if (a === 'node:claim' || a.startsWith('claim:')) return t('the community’s first owner');
    if (a.startsWith('server:')) return t('the server’s shell');
    if (a.startsWith('migration:')) return t('BeanPool, when vouchers started');
    if (!a || HEX_KEY.test(a)) return t('someone who has left');
    return t('the community’s server');
}

const day = (iso: string | null | undefined): string => {
    const d = iso ? new Date(iso) : null;
    return d && Number.isFinite(d.getTime()) ? formatDate(d, 'day-month') : '';
};

/** One Budget history line in words (§3: "+1,000 budget, made a voucher by @marty, 5 Nov · −100 held for an invite"). */
export function historyLineWords(h: VoucherHistoryLine): string {
    const date = day(h.at);
    const actor = voucherActorWords(h);
    const amount = formatNumber(Math.abs(h.amount));
    switch (h.kind) {
        case 'grant': return t('+{amount} budget, made a voucher by {actor}, {date}', { amount, actor, date });
        case 'top_up': return t('+{amount} top-up by {actor}, {date}', { amount, actor, date });
        case 'lower': return t('−{amount} lower by {actor}, {date}', { amount, actor, date });
        case 'hold':
            return h.for === 'profile' && h.person
                ? t('−{amount} held for @{name}, {date}', { amount, name: h.person.callsign, date })
                : t('−{amount} held for an invite, {date}', { amount, date });
        case 'return':
            if (h.why === 'expired') return t('+{amount} back, invite expired, {date}', { amount, date });
            if (h.why === 'stopped') return t('+{amount} back, budget stopped, {date}', { amount, date });
            if (h.why === 'not_landed') return t('+{amount} back, vouch didn’t land, {date}', { amount, date });
            return t('+{amount} back, {date}', { amount, date });
        case 'stop': return t('Budget stopped by {actor}, {date}', { actor, date });
        default: return t('Budget changed by {actor}, {date}', { actor, date });
    }
}

// ── The card's head (§5: "@jane: confirmed by @marty, 3 Nov · made a voucher by @marty, 5 Nov") ─────────────────────

/**
 * The card's second line. The confirmation half comes from the names list's own entry (`entry.confirmation`, the live
 * confirmation of this member), with who confirmed it; opened from People → Invites there is no entry, so it is the
 * callsign alone. The appointment half is the node's `madeBy` (a role budget says so instead).
 */
export function voucherCardSubtitle(
    card: Pick<VoucherSummaryRow, 'memberPubkey' | 'callsign' | 'source' | 'madeBy' | 'madeByCallsign' | 'madeAt'>,
    confirmation: ConfirmationRow | null | undefined,
    nameOf: (pubkey: string) => string = () => '',
): string {
    const who = card.callsign ? `@${card.callsign}` : '';
    const byName = (pk: string | null) => {
        const c = pk ? nameOf(pk) : '';
        return c ? `@${c}` : t('an admin');
    };
    const conf = confirmation && confirmation.status === 'confirmed' && confirmation.memberPubkey === card.memberPubkey ? confirmation : null;
    const confirmedPart = conf
        ? (conf.secondedBy
            ? t('{who}: confirmed by {by} and {second}, {date}', { who: who || t('this member'), by: byName(conf.confirmedBy), second: byName(conf.secondedBy), date: day(conf.secondedAt ?? conf.confirmedAt) })
            : t('{who}: confirmed by {by}, {date}', { who: who || t('this member'), by: byName(conf.confirmedBy), date: day(conf.confirmedAt) }))
        : who;
    // An owner's own budget is theirs by role; an admin an owner made a voucher (also source 'role') names that owner,
    // as the web card and the manager do.
    const madePart = card.source === 'role' && !card.madeByCallsign
        ? t('made a voucher by role')
        : card.madeBy
            ? t('made a voucher by {actor}, {date}', { actor: voucherActorWords({ actor: card.madeBy, actorCallsign: card.madeByCallsign }), date: day(card.madeAt) })
            : '';
    return [confirmedPart, madePart].filter(Boolean).join(' · ');
}

// ── The names list (§2, §10) ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Whether the names list offers Make a voucher on an entry: only to the credit committee (`onCommittee`: the node answered
 * GET /api/names/vouchers for this viewer), on an entry that is not a voucher yet, whose confirmation is complete (not
 * waiting for a second admin, not revoked), and never on the viewer's own entry. `ownerOnlyTargets`: the members only an
 * owner may make a voucher (an admin, to anyone who is not an owner: {@link ownerOnlyVoucherTargets}), who are not offered
 * it (the node answers 403 `owner_only`). The node checks all of it again.
 */
export function canMakeVoucher(
    entry: Pick<OpenedEntry, 'voucher' | 'confirmation'>,
    onCommittee: boolean,
    viewer: string | null | undefined,
    ownerOnlyTargets?: ReadonlySet<string>,
): boolean {
    if (!onCommittee || !viewer) return false;
    if (entry.voucher) return false;
    const c = entry.confirmation;
    return !!c && c.status === 'confirmed' && c.memberPubkey !== viewer && !ownerOnlyTargets?.has(c.memberPubkey);
}

/**
 * The members this viewer may not make a voucher, because only an owner makes an admin one (slice I5; Marty, 10 Nov): every
 * admin on the names list's state when the viewer is not an owner, and nobody when they are. Owners are not in it: an owner
 * vouches by role and already holds a budget.
 */
export function ownerOnlyVoucherTargets(
    admins: ReadonlyArray<{ pubkey: string; role: string }> | null | undefined,
    viewerIsOwner: boolean,
): ReadonlySet<string> {
    if (viewerIsOwner || !admins) return new Set();
    return new Set(admins.filter((a) => a.role === 'admin').map((a) => a.pubkey));
}

/** Who Make a voucher names: the confirmation's callsign, else the community's, else the entry's name, else nothing. */
export function voucherCallsignFor(entry: Pick<OpenedEntry, 'confirmation' | 'text'>, callsignOf: (pubkey: string) => string): string {
    const c = entry.confirmation;
    return c?.callsign || (c ? callsignOf(c.memberPubkey) : '') || entry.text?.name || '';
}

/** Role vouchers (owners and admins, by role) with no entry on the list: the Vouchers filter's "Add their name" rows. */
export function roleVouchersWithoutEntry(vouchers: VoucherSummaryRow[] | null | undefined, entries: Pick<OpenedEntry, 'voucher' | 'confirmation'>[]): VoucherSummaryRow[] {
    if (!vouchers) return [];
    const onList = new Set<string>();
    for (const e of entries) {
        if (e.voucher) onList.add(e.voucher.memberPubkey);
        if (e.confirmation) onList.add(e.confirmation.memberPubkey);
    }
    return vouchers.filter((v) => !onList.has(v.memberPubkey));
}

/** The search box on those rows: a callsign containing what was typed, any case. */
export function filterRoleVouchers(rows: VoucherSummaryRow[], query: string): VoucherSummaryRow[] {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return rows;
    return rows.filter((v) => (v.callsign || '').toLocaleLowerCase().includes(q));
}
