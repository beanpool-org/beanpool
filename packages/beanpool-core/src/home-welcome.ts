/**
 * Welcome's lines (scratch/fable-design/DESIGN-home-default-fable.md §2.3, §5.1), one rule for the phone and the web, from
 * the one Home answer (routes/home-answer.ts):
 *
 * - **Where you are.** "You're in {community}." with the community's own name; on the worldwide community "You're in the
 *   global community" (the sentence the phone's join already says, so no name is written into a sentence that has to
 *   read in 25 languages). A local community whose name the answer doesn't carry: no line, never a stand-in name.
 * - **Who brought you.** "{name} invited you. Say hello ›", with the name and key of whoever's invite they used
 *   (`me.invitedBy`). No inviter, or one with no name to say: the line is not drawn (§2.3 "No inviter known … the line
 *   is not drawn"); a "Someone" nobody can place is no one to say hello to.
 * - **The first one here.** An owner alone on a new local community: "You're the first one here." in the inviter's place.
 *   Never for a member someone invited (whoever invited them is here too, so it would not be true), never on the
 *   worldwide community. Its "Invite someone ›" is the app's to add, only where the reader can invite.
 *
 * Pure: no I/O and no Node built-ins (the barrel is bundled for the phone).
 */
import { PROTOCOL_CONSTANTS } from './protocol.js';
import { t, word } from './words.js';

/**
 * The WELCOME TO BEANPOOL! tile's words (scratch/fable-design/DESIGN-onboarding-home-landing-fable.md §4.1 item 1, Marty's
 * pick of 21 Nov 2026, slice S5): what How it Works said in 363 words, as three things to know. Shown through t().
 */
export const WELCOME_TILE_WORDS = {
    title: word('Welcome to BeanPool!'),
    offer: word('Offer something first. Then ask for anything.'),
    beans: word("Beans keep score: about {n} for an hour's help."),
    zero: word('Zero is a good balance: you give as much as you get.'),
    meet: word('Meet people and find a community near you.'),
    noBeans: word('No Beans here. Trading in Beans happens in local communities.'),
    tour: word('Show me around'),
    gotIt: word('Got it'),
} as const;

/** Which picture a tile line wears (the app maps it to an icon it bundles): give and take, the scales, zero, people. */
export type WelcomeTileIcon = 'swap' | 'scale' | 'zero' | 'meet' | 'none';
export interface WelcomeTileLine { icon: WelcomeTileIcon; text: string }

/**
 * The tile's lines, in the member's language. Where Beans are on: offer first, the hour's rate, zero is good (the rate is
 * the protocol's reference rate, the same on every community, never a setting: protocol.ts `REFERENCE_RATE`). The global
 * community, which has no Beans: who is here and where Beans live (§4.1). A local community with Beans off: the first line
 * alone, since the other two would not be true there.
 */
export function welcomeTileLines(where: { profile: string; beans: boolean }): WelcomeTileLine[] {
    if (where.profile === 'global') {
        return [
            { icon: 'meet', text: t(WELCOME_TILE_WORDS.meet) },
            { icon: 'none', text: t(WELCOME_TILE_WORDS.noBeans) },
        ];
    }
    const offer: WelcomeTileLine = { icon: 'swap', text: t(WELCOME_TILE_WORDS.offer) };
    if (!where.beans) return [offer];
    return [
        offer,
        { icon: 'scale', text: t(WELCOME_TILE_WORDS.beans, { n: Math.round(PROTOCOL_CONSTANTS.REFERENCE_RATE / 100) }) },
        { icon: 'zero', text: t(WELCOME_TILE_WORDS.zero) },
    ];
}

/** Welcome's sentences that say where the member is: shown through t() by {@link welcomeFacts}. */
export const WELCOME_PLACE_WORDS = {
    local: word("You're in {community}."),
    global: word("You're in the global community"),
} as const;

/** What Welcome says, in the member's language where it is a sentence. */
export interface WelcomeFacts {
    /** "You're in {community}." / "You're in the global community"; null when a local community's name isn't known. */
    place: string | null;
    /** Whose invite brought them, with a name to say. */
    inviter: { key: string; name: string } | null;
    /** An owner alone on a new local community, nobody's invitee. */
    firstHere: boolean;
}

/** The parts of a Home answer Welcome reads (both apps' answers have this shape). */
export interface WelcomeAnswer {
    profile: string;
    me?: { invitedBy?: { key?: unknown; name?: unknown } | null } | null;
    cards?: { community?: { name?: string | null; members?: number | null } | null } | null;
}

export function welcomeFacts(answer: WelcomeAnswer): WelcomeFacts {
    const global = answer.profile === 'global';
    const name = typeof answer.cards?.community?.name === 'string' ? answer.cards.community.name.trim() : '';
    const place = global ? t(WELCOME_PLACE_WORDS.global) : name ? t(WELCOME_PLACE_WORDS.local, { community: name }) : null;
    const by = answer.me?.invitedBy;
    const said = by && typeof by.key === 'string' && by.key && typeof by.name === 'string' ? by.name.trim() : '';
    const inviter = said ? { key: by!.key as string, name: said } : null;
    const members = answer.cards?.community?.members;
    const firstHere = !global && !by && typeof members === 'number' && members <= 1;
    return { place, inviter, firstHere };
}

/**
 * Whether the reader can invite here (Welcome's "Invite someone ›", and the phone's First steps line): invites are on, and
 * where only the community's admins invite (`features.door === 'admins'`) the node has said the reader is an owner or an
 * admin. A role not heard yet counts as no: Home never offers what may not work (PR #1483 review 4166559683).
 */
export function readerMayInvite(features: { invites?: unknown; door?: unknown }, role: string | null | undefined): boolean {
    if (features.invites !== true) return false;
    if (features.door !== 'admins') return true;
    return role === 'owner' || role === 'admin';
}
