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
import { isKeptCommunityWelcome } from './community-welcome.js';
import { WELCOME_BAND_DAYS } from './home-frame.js';

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
    /** The tile folded to one band after seven days (§4.2): the band opens it again. */
    band: word('Welcome to BeanPool ›'),
    /** The band's ×, as a screen reader names it. */
    away: word('Put the welcome away'),
    /** The tile, and the band's open button, as a screen reader names them. */
    name: word('Welcome to BeanPool'),
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

// ── The community's own welcome on Home (DESIGN-onboarding-home-landing-fable.md §4.1 item 2, §4.2, §4.3, §4.5; slice S7) ──

/**
 * Where the community's welcome is put away: one more key in the Home layout's `dismissed` map (`{ card id: date }`, the
 * map that keeps when "Your way back in" was put away), so it holds on every device of the account. A new key, no new
 * shape; never a card id (no card type has a `-welcome` instance).
 */
export const COMMUNITY_WELCOME_DISMISSED_KEY = 'community-welcome';

/** The community's welcome card's own words, shown through t(). The owners' words themselves never are. */
export const COMMUNITY_WELCOME_CARD_WORDS = {
    /** The card's caption, drawn in capitals: "FROM RIVERSIDE". */
    caption: word('From {community}'),
    /** A community whose name the answer doesn't carry (the notices card's name, the same English). */
    captionUnnamed: word('From your community'),
    /** An owner of a community whose server keeps a welcome, with none written yet. */
    write: word("Write your community's welcome ›"),
    /** The community card's line that shows the owners' words again once the welcome card has gone (§4.2 "Day 30"). */
    again: word("{community}'s welcome ›"),
    againUnnamed: word("Your community's welcome ›"),
    /** The card's ×, as a screen reader says it (the caption names the community). */
    away: word('Put this welcome away'),
} as const;

/** What the community's welcome card holds, when it is drawn. */
export interface CommunityWelcomeCard {
    /** "From Riverside", in the member's language. */
    caption: string;
    /** The owners' words exactly as they wrote them (never translated), or null where they wrote none. */
    words: string | null;
    /** Whose invite brought the reader, with a name to say ({@link welcomeFacts}). */
    inviter: { key: string; name: string } | null;
    /** An owner alone on a new local community ({@link welcomeFacts}). */
    firstHere: boolean;
    /** The community's members, for "84 members"; null where the answer has no count, and for the first one here. */
    members: number | null;
    /** "Write your community's welcome ›": an owner, on a server that keeps a welcome, with none written. */
    ownerPrompt: boolean;
}

/** The parts of a Home answer the community's welcome reads (both apps' answers have this shape). */
export interface CommunityWelcomeAnswer extends WelcomeAnswer {
    me?: { joinedAt?: unknown; invitedBy?: { key?: unknown; name?: unknown } | null } | null;
    cards?: { community?: { name?: string | null; members?: number | null; welcome?: unknown } | null } | null;
}

const DAY_MS = 86_400_000;

/** The owners' welcome as an app may draw it: a kept text (core `isKeptCommunityWelcome`), else none. */
export function communityWelcomeWords(answer: Pick<CommunityWelcomeAnswer, 'cards'>): string | null {
    const raw = answer.cards?.community?.welcome;
    return isKeptCommunityWelcome(raw) ? raw : null;
}

/**
 * The community's welcome card under BeanPool's tile (§4.1 item 2), or null where it is not drawn. One rule for both apps.
 *
 * - **Whose:** a member's, never a visitor's. A newcomer's, in the same window as BeanPool's welcome: from joining to day
 *   30 ({@link WELCOME_BAND_DAYS}), then never (§4.2 "Day 30": Home is the member's own). A join date not heard keeps it,
 *   as it keeps BeanPool's tile: never hidden for a missing fact.
 * - **Its own life:** it stays until its own × (`dismissedAt`, the layout's {@link COMMUNITY_WELCOME_DISMISSED_KEY}), not
 *   BeanPool's Got it or the tour's end, and it is drawn in a second community on the same phone, where BeanPool's part
 *   is not (§3.3).
 * - **What it holds:** the owners' words as written; under them the inviter's line, or "You're the first one here."; the
 *   member count. No owners' words yet: the inviter's line and the count alone. An owner of a community whose server
 *   keeps a welcome and has none (`welcome: null`) is asked to write one; a server from before it (no field) asks nothing.
 * - **Nothing to say:** no words, no inviter, not the first one here and no prompt: not drawn ("cards with nothing to show
 *   stay undrawn"). The community card at the foot already gives the count.
 */
export function communityWelcomeCard(
    answer: CommunityWelcomeAnswer,
    ctx: { role?: string | null; dismissedAt?: string | null; now?: number } = {},
): CommunityWelcomeCard | null {
    const me = answer.me;
    const community = answer.cards?.community;
    if (!me || !community || ctx.dismissedAt) return null;
    const joined = typeof me.joinedAt === 'string' ? Date.parse(me.joinedAt) : NaN;
    if (Number.isFinite(joined) && (ctx.now ?? Date.now()) - joined >= WELCOME_BAND_DAYS * DAY_MS) return null;
    const words = communityWelcomeWords(answer);
    const facts = welcomeFacts(answer);
    const ownerPrompt = !words && community.welcome === null && ctx.role === 'owner';
    if (!words && !facts.inviter && !facts.firstHere && !ownerPrompt) return null;
    const name = typeof community.name === 'string' ? community.name.trim() : '';
    return {
        caption: name ? t(COMMUNITY_WELCOME_CARD_WORDS.caption, { community: name }) : t(COMMUNITY_WELCOME_CARD_WORDS.captionUnnamed),
        words,
        inviter: facts.inviter,
        firstHere: facts.firstHere,
        members: !facts.firstHere && typeof community.members === 'number' && community.members > 0 ? community.members : null,
        ownerPrompt,
    };
}

/**
 * The community card's line that opens the owners' words again (§4.2 "Day 30"): "Riverside's welcome ›", where the owners
 * wrote words, for whenever the welcome card itself is not drawn (put away, or past the newcomer's days). Null where they
 * wrote none. The app draws it only while {@link communityWelcomeCard} is null, so the words are never on Home twice.
 */
export function communityWelcomeAgainLine(answer: Pick<CommunityWelcomeAnswer, 'cards'>): string | null {
    if (!communityWelcomeWords(answer)) return null;
    const name = typeof answer.cards?.community?.name === 'string' ? answer.cards.community.name.trim() : '';
    return name ? t(COMMUNITY_WELCOME_CARD_WORDS.again, { community: name }) : t(COMMUNITY_WELCOME_CARD_WORDS.againUnnamed);
}
