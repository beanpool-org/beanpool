/**
 * The quick vouch on an invite (Marty, 3 Nov): what both apps' invite screens offer someone who can vouch. The node decides
 * (apps/server state-engine.ts readInviteVouch); these only say what to show, and the same on both apps.
 */
import { VOUCH_LEVELS, vouchCreditForLevel, type VouchLevel } from './protocol.js';
import { t, word } from './words.js';

export const INVITE_VOUCH_WORDS = {
    label: word('Vouch for them'),
    none: word('None'),
    beans: word('{amount} Beans'),
    noOfflineVouch: word('You can’t vouch on an offline ticket. Choose None to make one, or try again when you’re connected.'),
    // The node's own two refusals (apps/server state-engine.ts readInviteVouch), which it sends in English.
    badLevel: word('A vouch on an invite is 25, 50 or 100 Beans, or none.'),
    notAVoucher: word('Only owners, admins and appointed vouchers can vouch for someone on an invite.'),
};

/** A refusal of a vouch as the member reads it: the node's two sentences in their language, anything else as it came. */
export function inviteVouchRefusalWords(said: string): string {
    if (said === INVITE_VOUCH_WORDS.badLevel) return t(INVITE_VOUCH_WORDS.badLevel);
    if (said === INVITE_VOUCH_WORDS.notAVoucher) return t(INVITE_VOUCH_WORDS.notAVoucher);
    return said;
}

/** None first, selected every time the screen opens, then the three levels with the Beans each hands out. */
export const INVITE_VOUCH_CHOICES: readonly { level: VouchLevel | null; amount: number | null }[] = [
    { level: null, amount: null },
    ...VOUCH_LEVELS.map((level) => ({ level, amount: vouchCreditForLevel(level) })),
];

/**
 * Whether the control shows: the node says an invite can carry a vouch here (features.inviteVouch: a node with Beans, and
 * of a version that keeps one, so a phone newer than its node never shows a choice the node would drop), and says this
 * member can give one (`canVouch` on their own balance). Not heard yet, or no answer: no control. A role or an appointment,
 * never a tier.
 */
export function offersInviteVouch(features: { inviteVouch?: boolean } | null | undefined, canVouch: boolean | null | undefined): boolean {
    return features?.inviteVouch === true && canVouch === true;
}
