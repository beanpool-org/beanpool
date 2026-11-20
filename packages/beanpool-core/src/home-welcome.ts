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
import { formatCount, t, tn, word } from './words.js';
import { WELCOME_BAND_DAYS, defaultHomeLayout, type HomeLayoutV2 } from './home-frame.js';
import { COMMUNITY_CARD_WORDS } from './community-card.js';
import { isKeptCommunityWelcome } from './community-welcome.js';

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

// ── The community's welcome on Home ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The key a member's × on the community's welcome leaves in the Home layout's `dismissed` map (`{ card id: date }`,
 * home-frame.ts `HomeLayoutV2`), on the account, so the phone and the web agree (DESIGN-onboarding-home-landing-fable.md
 * §4.3: "one more entry in the Home layout's dismissed map … A new key, no new shape"). Both apps' slices use this one key
 * (web W2, phone S7). It is no card's id, so no card is hidden by it.
 */
export const COMMUNITY_WELCOME_DISMISSED = 'welcome-community';

/** The community's welcome's own words (§4.1 item 2), shown through t(); the owners' words themselves never are. */
export const COMMUNITY_WELCOME_HOME_WORDS = {
    /** Its caption: "FROM RIVERSIDE", capitals by style. */
    from: word('From {community}'),
    /** Its caption where the answer carries no name for the community. */
    fromYours: word('From your community'),
    /** Its ×, as a screen reader names it. */
    away: word("Put {community}'s welcome away"),
    awayYours: word("Put your community's welcome away"),
    /** To an owner, where none is written yet: opens the community's Settings, where it is written (slice S6). */
    write: word("Write your community's welcome ›"),
} as const;

/** The parts of a Home answer the community's welcome reads (both apps' answers have this shape). */
export interface CommunityWelcomeAnswer {
    /** A visitor's answer (the web's lobby): no welcome. */
    welcome?: unknown;
    me?: { joinedAt?: string | null; standing?: string } | null;
    cards?: { community?: { name?: string | null; members?: number | null; welcome?: string | null } | null } | null;
}

/** What the community's welcome on Home says (§4.1 item 2), in the member's language where the words are ours. */
export interface CommunityWelcomeView {
    /** "From Riverside" / "From your community". */
    caption: string;
    /** The ×'s name. */
    away: string;
    /** The owners' words, exactly as written (never translated, §4.5); null where none are written or the server is older. */
    text: string | null;
    /**
     * The server said none is written (`welcome: null`), as opposed to a server from before the setting, which sends no field:
     * only then is an owner asked to write one ({@link COMMUNITY_WELCOME_HOME_WORDS} `write`), since only then can they.
     */
    unwritten: boolean;
    /** "84 members"; null where the answer carries no count. */
    members: string | null;
}

/**
 * The community's welcome on Home, or null where it is not drawn (DESIGN-onboarding-home-landing-fable.md §4.1 item 2,
 * §4.2; Marty's picks of 21 Nov 2026). A newcomer's, like the tile: a member (never a visitor or a suspended member) in
 * their first {@link WELCOME_BAND_DAYS} days, until their own × (the {@link COMMUNITY_WELCOME_DISMISSED} entry in the
 * layout's `dismissed`), whatever became of BeanPool's tile, since it is the community's and not ours ("The community's
 * welcome stays until its own ×"). A join date the node didn't send or can't be read keeps it, never hides it, as
 * home-frame.ts `welcomeShape` does. With no owners' words it still says who brought them and the count (§4.1: "No
 * owner's words yet: the inviter line and the count alone"); the inviter's line is the app's, from {@link welcomeFacts}.
 * Whether it says enough to be drawn is {@link communityWelcomeSays}.
 *
 * Only a welcome as one is kept is shown ({@link isKeptCommunityWelcome}): anything else is no words, never a stand-in.
 */
export function communityWelcomeView(
    answer: CommunityWelcomeAnswer,
    layout: Pick<HomeLayoutV2, 'dismissed'> | null | undefined,
    now: number = Date.now(),
): CommunityWelcomeView | null {
    const me = answer.me;
    if (answer.welcome || !me || (me.standing !== undefined && me.standing !== 'member')) return null;
    if (layout?.dismissed && Object.prototype.hasOwnProperty.call(layout.dismissed, COMMUNITY_WELCOME_DISMISSED)) return null;
    const joined = typeof me.joinedAt === 'string' ? Date.parse(me.joinedAt) : NaN;
    if (Number.isFinite(joined) && now - joined >= WELCOME_BAND_DAYS * 86_400_000) return null;
    const card = answer.cards?.community;
    const name = typeof card?.name === 'string' ? card.name.trim() : '';
    const said = card?.welcome;
    const count = card?.members;
    return {
        caption: name ? t(COMMUNITY_WELCOME_HOME_WORDS.from, { community: name }) : t(COMMUNITY_WELCOME_HOME_WORDS.fromYours),
        away: name ? t(COMMUNITY_WELCOME_HOME_WORDS.away, { community: name }) : t(COMMUNITY_WELCOME_HOME_WORDS.awayYours),
        text: isKeptCommunityWelcome(said) ? said : null,
        unwritten: said === null,
        members: typeof count === 'number' && Number.isFinite(count) && count > 0
            ? tn(count, COMMUNITY_CARD_WORDS.members.one, COMMUNITY_CARD_WORDS.members.other, { n: formatCount(count) })
            : null,
    };
}

/**
 * Whether the community's welcome has anything to say, so is drawn at all (Home's rule: a card with nothing to show takes no
 * room): the owners' words, who brought the member or "You're the first one here." ({@link welcomeFacts}), or, to an owner
 * where the node says none is written, the way to write one. The count alone is not enough: the community card at the foot
 * of Home already says it.
 */
export function communityWelcomeSays(
    view: CommunityWelcomeView | null,
    facts: Pick<WelcomeFacts, 'inviter' | 'firstHere'>,
    readerIsOwner: boolean,
): boolean {
    if (!view) return false;
    return view.text !== null || !!facts.inviter || facts.firstHere || (readerIsOwner && view.unwritten);
}

/**
 * The member's × on the community's welcome: the layout with its {@link COMMUNITY_WELCOME_DISMISSED} entry, dated `now`,
 * the cards untouched. A Home never saved is the default list with it (as each app's `dismissSafety` does for "Your way
 * back in"), so the newcomer's Home is not changed by it.
 */
export function dismissCommunityWelcome(layout: HomeLayoutV2 | null | undefined, now: number): HomeLayoutV2 {
    const base = layout ?? defaultHomeLayout();
    const at = new Date(now).toISOString();
    return { ...base, dismissed: { ...base.dismissed, [COMMUNITY_WELCOME_DISMISSED]: at }, updatedAt: at };
}
