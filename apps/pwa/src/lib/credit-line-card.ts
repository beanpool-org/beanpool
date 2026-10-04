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

export const KNOWN_FROZEN_TITLE = 'Your credit line is frozen';
export const KNOWN_FROZEN_BODY = 'Your community\'s admins have frozen your credit line, so for now you can\'t go below zero. '
    + 'You can still trade with the Beans you hold: sell, receive Beans, and pay with what you have. '
    + 'To ask why, or to have it opened again, ask one of the admins.';
export const KNOWN_FROZEN_PART = 'Your community\'s admins have frozen the part of your credit line that comes from being a '
    + 'confirmed member; the rest works as before. To ask why, ask one of the admins.';
