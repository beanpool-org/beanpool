/**
 * Which credit-line card the Ledger tab shows above its tabs, from the node's balance answer (GET /api/ledger/balance,
 * getBalance in apps/server state-engine.ts).
 *
 * The community's admins can freeze a member's line two ways: `creditFrozen`, the whole line (the manager's "Freeze" on
 * a member, adminSetCreditFrozen), and `knownFrozen`, the known floor's part (an exception, apps/server
 * config/known-floor.ts). Rehearsal 5 Oct, b: a frozen member was told "No credit line yet … opens automatically after
 * your first trade", which is untrue for them. The tier is not this card's: the node keeps the one their line would
 * give them (tiers are merit badges), and the Ledger shows it as before. The phone has the same (apps/native/utils/credit-line-card.ts).
 */
export interface CreditLineState {
    activated?: boolean;
    knownFrozen?: boolean;
    creditFrozen?: boolean;
}

/** 'frozen': the admins froze the line they had. 'none': no line yet. 'bar': the credit bar. */
export function creditLineCard(b: CreditLineState): 'frozen' | 'none' | 'bar' {
    if (b.creditFrozen === true) return 'frozen';
    if (b.activated === false) return b.knownFrozen === true ? 'frozen' : 'none';
    return 'bar';
}

/** Under the bar: the known part frozen while another part (vouched, earned or granted) still works. */
export function knownFrozenPartNote(b: CreditLineState): string | null {
    return creditLineCard(b) === 'bar' && b.knownFrozen === true ? KNOWN_FROZEN_PART : null;
}

// True whether the member was in credit or in debit when the admins froze the line (r4178376534): one frozen in debit is
// already below zero and holds no Beans to pay with, so the card says what they can do, and frozenDebitLine how far down
// they are (the bar would read a 0 floor and hide it).
export const KNOWN_FROZEN_TITLE = 'Your credit line is frozen';
export const KNOWN_FROZEN_BODY = 'Your community\'s admins have frozen your credit line, so for now you can\'t spend into debit. '
    + 'You can still sell and receive Beans, and spend what you hold above zero. '
    + 'To ask why, or to have it opened again, ask one of the admins.';

/** On the frozen card, for a member in debit: how far below zero they are and how they come back up. Null at zero or above. */
export function frozenDebitLine(balance: number | undefined): string | null {
    if (typeof balance !== 'number' || !(balance < 0)) return null;
    const owed = Math.ceil(-balance * 10) / 10;
    return `You are ${Number.isInteger(owed) ? owed : owed.toFixed(1)} Beans in debit. Selling or receiving Beans brings you back up, `
        + 'and once you are above zero you can spend what you hold.';
}
export const KNOWN_FROZEN_PART = 'Your community\'s admins have frozen the part of your credit line that comes from being a '
    + 'confirmed member; the rest works as before. To ask why, ask one of the admins.';
