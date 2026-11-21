/**
 * The community's welcome on Home (home-welcome.ts communityWelcomeCard, scratch/fable-design/DESIGN-onboarding-home-landing-
 * fable.md §4.1 item 2, §4.2, §4.3, §4.5; slice S7): one rule both apps read. Every case of the slice's table: no welcome
 * written, a welcome written, after its ×, an owner with none (the prompt), a member who is not an owner, a second community
 * on the same phone (this rule never reads BeanPool's once-per-phone mark), and a server from before the field.
 */
import { describe, expect, it } from 'vitest';
import {
    COMMUNITY_WELCOME_CARD_WORDS, COMMUNITY_WELCOME_DISMISSED_KEY, communityWelcomeAgainLine, communityWelcomeCard, communityWelcomeWords,
    type CommunityWelcomeAnswer,
} from '../home-welcome.js';
import { COMMUNITY_WELCOME_MAX_CHARS } from '../community-welcome.js';
import { WELCOME_BAND_DAYS } from '../home-frame.js';
import { pseudoLocalise, setLanguage } from '../words.js';

const NOW = Date.parse('2026-11-21T03:00:00.000Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const ASHA = { key: 'aa'.repeat(32), name: 'Asha' };
const WORDS = "G'day and welcome. Market day is Saturday at the hall.\nPost what you grow, make or can lend.";

function answer(over: {
    welcome?: unknown; joinedDaysAgo?: number | null; invitedBy?: { key: string; name: string } | null; members?: number; name?: string | null;
    profile?: string; me?: null;
} = {}): CommunityWelcomeAnswer {
    const community: Record<string, unknown> = { name: over.name === undefined ? 'Riverside' : over.name, members: over.members ?? 84 };
    if ('welcome' in over) community.welcome = over.welcome;
    const me = over.me === null ? null : {
        joinedAt: over.joinedDaysAgo === null ? null : iso(NOW - (over.joinedDaysAgo ?? 0) * DAY),
        invitedBy: over.invitedBy === undefined ? ASHA : over.invitedBy,
    };
    return { profile: over.profile ?? 'local', me, cards: { community } } as CommunityWelcomeAnswer;
}

describe('S7: what the card holds', () => {
    it('a welcome written: the owners\' words as written, the inviter\'s line, the count; caption "From Riverside"', () => {
        expect(communityWelcomeCard(answer({ welcome: WORDS }), { now: NOW })).toEqual({
            caption: 'From Riverside', words: WORDS, inviter: ASHA, firstHere: false, members: 84, ownerPrompt: false,
        });
    });

    it('no welcome written (null): the inviter\'s line and the count alone, no prompt for a member', () => {
        const card = communityWelcomeCard(answer({ welcome: null }), { now: NOW, role: null })!;
        expect(card.words).toBeNull();
        expect(card.inviter).toEqual(ASHA);
        expect(card.members).toBe(84);
        expect(card.ownerPrompt).toBe(false);
    });

    it('an owner of a community with none written: asked to write one; with one written, never', () => {
        const owner = communityWelcomeCard(answer({ welcome: null, invitedBy: null }), { now: NOW, role: 'owner' })!;
        expect(owner.ownerPrompt).toBe(true);
        expect(owner.inviter).toBeNull();
        expect(communityWelcomeCard(answer({ welcome: WORDS, invitedBy: null }), { now: NOW, role: 'owner' })!.ownerPrompt).toBe(false);
    });

    it('not an owner (an admin, a moderator, a member, a role not heard): no prompt, and nothing else to say draws nothing', () => {
        for (const role of ['admin', 'moderator', null, undefined]) {
            expect(communityWelcomeCard(answer({ welcome: null, invitedBy: null }), { now: NOW, role }), String(role)).toBeNull();
            expect(communityWelcomeCard(answer({ welcome: null }), { now: NOW, role })!.ownerPrompt, String(role)).toBe(false);
        }
    });

    it('a server from before the field (a 1.4.7 community): no words and no prompt, even for an owner; the inviter\'s line stays', () => {
        const old = answer();
        expect('welcome' in (old.cards!.community as object)).toBe(false);
        expect(communityWelcomeCard(old, { now: NOW, role: 'owner' })).toEqual({
            caption: 'From Riverside', words: null, inviter: ASHA, firstHere: false, members: 84, ownerPrompt: false,
        });
        expect(communityWelcomeCard(answer({ invitedBy: null }), { now: NOW, role: 'owner' })).toBeNull();
    });

    it('the first one here: "You\'re the first one here." in the inviter\'s place, no count of one', () => {
        const card = communityWelcomeCard(answer({ welcome: null, invitedBy: null, members: 1 }), { now: NOW, role: 'owner' })!;
        expect(card.firstHere).toBe(true);
        expect(card.members).toBeNull();
        expect(card.ownerPrompt).toBe(true);
    });

    it('a name the answer doesn\'t carry: "From your community", never a stand-in name', () => {
        expect(communityWelcomeCard(answer({ welcome: WORDS, name: null }), { now: NOW })!.caption).toBe('From your community');
        expect(communityWelcomeCard(answer({ welcome: WORDS, name: '  ' }), { now: NOW })!.caption).toBe('From your community');
    });

    it('a value that is not a welcome as one is kept (an odd server): no words drawn, nothing else changed', () => {
        for (const odd of ['', '   x  ', 'a\u0007b', 'x'.repeat(COMMUNITY_WELCOME_MAX_CHARS + 1), 'a\nb\nc\nd\ne', 42, {}]) {
            expect(communityWelcomeWords(answer({ welcome: odd })), JSON.stringify(odd)).toBeNull();
        }
        expect(communityWelcomeCard(answer({ welcome: 'a\u0007b' }), { now: NOW })!.words).toBeNull();
    });

    it('the caption and the prompt in the member\'s language; the owners\' words never translated', () => {
        setLanguage('xx');
        try {
            const card = communityWelcomeCard(answer({ welcome: WORDS }), { now: NOW })!;
            expect(card.caption).toBe(pseudoLocalise('From {community}').replace('{community}', 'Riverside'));
            expect(card.words).toBe(WORDS);
        } finally {
            setLanguage('en');
        }
    });
});

describe('S7: when it is drawn', () => {
    it('a member\'s only, never a visitor\'s', () => {
        expect(communityWelcomeCard(answer({ welcome: WORDS, me: null }), { now: NOW })).toBeNull();
        expect(communityWelcomeCard({ profile: 'local', me: { joinedAt: iso(NOW) }, cards: {} }, { now: NOW })).toBeNull();
    });

    it('a newcomer\'s, from joining to day 30 (BeanPool\'s window), then never; a join date not heard keeps it', () => {
        expect(communityWelcomeCard(answer({ welcome: WORDS, joinedDaysAgo: 0 }), { now: NOW })).not.toBeNull();
        expect(communityWelcomeCard(answer({ welcome: WORDS, joinedDaysAgo: 8 }), { now: NOW })).not.toBeNull();
        expect(communityWelcomeCard(answer({ welcome: WORDS, joinedDaysAgo: WELCOME_BAND_DAYS - 1 }), { now: NOW })).not.toBeNull();
        expect(communityWelcomeCard(answer({ welcome: WORDS, joinedDaysAgo: WELCOME_BAND_DAYS }), { now: NOW })).toBeNull();
        expect(communityWelcomeCard(answer({ welcome: WORDS, joinedDaysAgo: 200 }), { now: NOW })).toBeNull();
        expect(communityWelcomeCard(answer({ welcome: WORDS, joinedDaysAgo: null }), { now: NOW })).not.toBeNull();
    });

    it('until its own × (the layout\'s dismissed key), whatever BeanPool\'s tile does', () => {
        expect(COMMUNITY_WELCOME_DISMISSED_KEY).toBe('community-welcome');
        expect(communityWelcomeCard(answer({ welcome: WORDS }), { now: NOW, dismissedAt: iso(NOW - DAY) })).toBeNull();
        expect(communityWelcomeCard(answer({ welcome: null }), { now: NOW, role: 'owner', dismissedAt: iso(NOW) })).toBeNull();
    });

    it('a second community on the same phone, or the global community: the same rule (no once-per-phone mark here)', () => {
        // The rule takes no "elsewhere": BeanPool's part is once per phone; each community's own welcome is its own.
        expect(communityWelcomeCard(answer({ welcome: WORDS }), { now: NOW })).not.toBeNull();
        expect(communityWelcomeCard(answer({ welcome: WORDS, profile: 'global', invitedBy: null }), { now: NOW })!.words).toBe(WORDS);
    });
});

describe('S7: the community card\'s line to read the words again', () => {
    it('"Riverside\'s welcome ›" where the owners wrote words; none where they wrote none or the server has no field', () => {
        expect(communityWelcomeAgainLine(answer({ welcome: WORDS }))).toBe("Riverside's welcome ›");
        expect(communityWelcomeAgainLine(answer({ welcome: WORDS, name: null }))).toBe("Your community's welcome ›");
        expect(communityWelcomeAgainLine(answer({ welcome: null }))).toBeNull();
        expect(communityWelcomeAgainLine(answer())).toBeNull();
    });

    it('the words are the English the catalogs key on', () => {
        expect(COMMUNITY_WELCOME_CARD_WORDS).toEqual({
            caption: 'From {community}',
            captionUnnamed: 'From your community',
            write: "Write your community's welcome ›",
            again: "{community}'s welcome ›",
            againUnnamed: "Your community's welcome ›",
            away: 'Put this welcome away',
        });
    });
});
