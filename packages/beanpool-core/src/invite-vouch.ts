/**
 * The quick vouch on an invite (Marty, 3 Nov): what both apps' invite screens offer someone who can vouch. The node decides
 * (apps/server state-engine.ts readInviteVouch); these only say what to show, and the same on both apps.
 */
import { VOUCH_LEVELS, vouchCreditForLevel, type VouchLevel } from './protocol.js';
import { word } from './words.js';

export const INVITE_VOUCH_WORDS = {
    label: word('Vouch for them'),
    none: word('None'),
    beans: word('{amount} Beans'),
    noOfflineVouch: word('You can’t vouch on an offline ticket. Choose None to make one, or try again when you’re connected.'),
};

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
