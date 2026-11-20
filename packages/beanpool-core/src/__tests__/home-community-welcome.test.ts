/**
 * The community's welcome on Home (scratch/fable-design/DESIGN-onboarding-home-landing-fable.md §4.1 item 2, §4.2, §4.3;
 * Marty's picks of 21 Nov 2026): one rule both apps draw from (web slice W2, phone slice S7). A newcomer's for their first
 * 30 days, until their own ×, whatever became of BeanPool's tile; the owners' words as written, or none; the × kept as one
 * more entry in the layout's `dismissed` map.
 */
import { describe, expect, it } from 'vitest';
import { WELCOME_BAND_DAYS, checkHomeLayout, defaultHomeLayout, type HomeLayoutV2 } from '../home-frame.js';
import {
    COMMUNITY_WELCOME_DISMISSED, COMMUNITY_WELCOME_HOME_WORDS, communityWelcomeSays, communityWelcomeView, dismissCommunityWelcome,
    type CommunityWelcomeAnswer,
} from '../home-welcome.js';

const NOW = Date.parse('2026-11-21T03:00:00.000Z');
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

const answer = (over: { joinedAt?: string | null; standing?: string; welcome?: string | null; name?: string | null; members?: number; visitor?: true } = {}): CommunityWelcomeAnswer => ({
    ...(over.visitor ? { welcome: true } : {}),
    me: { joinedAt: 'joinedAt' in over ? over.joinedAt : daysAgo(0), standing: over.standing ?? 'member' },
    cards: {
        community: {
            name: 'name' in over ? over.name : 'Riverside',
            members: over.members ?? 84,
            ...('welcome' in over ? { welcome: over.welcome } : {}),
        },
    },
});

describe("the community's welcome on Home: who sees it and for how long", () => {
    it('the table: a newcomer until day 30 or their ×; never a visitor, a suspended member or a member of months', () => {
        const rows: [string, CommunityWelcomeAnswer, Pick<HomeLayoutV2, 'dismissed'> | null, boolean][] = [
            ['first arrival', answer(), null, true],
            ['day 8 (the tile is a band by now)', answer({ joinedAt: daysAgo(8) }), null, true],
            ['day 29', answer({ joinedAt: daysAgo(29) }), null, true],
            ['day 30', answer({ joinedAt: daysAgo(WELCOME_BAND_DAYS) }), null, false],
            ['day 31', answer({ joinedAt: daysAgo(31) }), null, false],
            ['after its ×', answer(), { dismissed: { [COMMUNITY_WELCOME_DISMISSED]: daysAgo(0) } }, false],
            ["after another card's × only", answer(), { dismissed: { safety: daysAgo(0) } }, true],
            ['a visitor', answer({ visitor: true }), null, false],
            ['a suspended member', answer({ standing: 'suspended' }), null, false],
            ['no join date sent: kept, never hidden for a missing fact', answer({ joinedAt: null }), null, true],
            ['a join date that cannot be read: kept', answer({ joinedAt: 'soon' }), null, true],
        ];
        for (const [what, a, layout, drawn] of rows) expect(communityWelcomeView(a, layout, NOW) !== null, what).toBe(drawn);
        expect(communityWelcomeView({ me: null }, null, NOW)).toBeNull();
    });

    it("the owners' words exactly as written, never translated; none written, none sent, or not a kept welcome: no words", () => {
        const written = "G'day and welcome. Market day is Saturday at the hall.\nPost what you grow, make or can lend.";
        expect(communityWelcomeView(answer({ welcome: written }), null, NOW)).toMatchObject({ text: written, unwritten: false });
        // None written: the server says null, so an owner may be asked to write one.
        expect(communityWelcomeView(answer({ welcome: null }), null, NOW)).toMatchObject({ text: null, unwritten: true });
        // A server from before the setting sends no field: no words, and nobody is asked to write what it can't keep.
        expect(communityWelcomeView(answer(), null, NOW)).toMatchObject({ text: null, unwritten: false });
        // Anything a server would not keep (too long, five lines, untrimmed) is drawn as no words, never as a stand-in.
        for (const bad of ['x'.repeat(281), 'a\nb\nc\nd\ne', ' padded ', '']) {
            expect(communityWelcomeView(answer({ welcome: bad }), null, NOW), JSON.stringify(bad)).toMatchObject({ text: null, unwritten: false });
        }
    });

    it('its caption, its ×\'s name and the count, in the member\'s words; no name, no stand-in name', () => {
        expect(communityWelcomeView(answer(), null, NOW)).toEqual({
            caption: 'From Riverside', away: "Put Riverside's welcome away", text: null, unwritten: false, members: '84 members',
        });
        const nameless = communityWelcomeView(answer({ name: '  ', members: 1 }), null, NOW)!;
        expect(nameless.caption).toBe('From your community');
        expect(nameless.away).toBe("Put your community's welcome away");
        expect(nameless.members).toBe('1 member');
        expect(communityWelcomeView(answer({ members: 2310 }), null, NOW)!.members).toBe('2,310 members');
        expect(communityWelcomeView(answer({ members: 0 }), null, NOW)!.members).toBeNull();
        expect(COMMUNITY_WELCOME_HOME_WORDS.write).toBe("Write your community's welcome ›");
    });
});

describe("the community's welcome is drawn only with something to say: never the count alone", () => {
    it('the table: words, an inviter, the first one here, or an owner asked to write one', () => {
        type Facts = { inviter: { key: string; name: string } | null; firstHere: boolean };
        const none: Facts = { inviter: null, firstHere: false };
        const ana: Facts = { inviter: { key: 'ana-key', name: 'Ana' }, firstHere: false };
        const written = communityWelcomeView(answer({ welcome: 'Market day is Saturday.' }), null, NOW);
        const unwritten = communityWelcomeView(answer({ welcome: null }), null, NOW);
        const older = communityWelcomeView(answer(), null, NOW);
        const rows: [string, ReturnType<typeof communityWelcomeView>, Facts, boolean, boolean][] = [
            ["the owners' words", written, none, false, true],
            ['an inviter with a name', older, ana, false, true],
            ['the first one here', older, { inviter: null, firstHere: true }, false, true],
            ['an owner, none written', unwritten, none, true, true],
            ['a member, none written: the count alone', unwritten, none, false, false],
            ['an owner on a server from before the setting: nothing to write in', older, none, true, false],
            ['the count alone', older, none, false, false],
            ['not drawn at all', null, ana, true, false],
        ];
        for (const [what, view, facts, owner, says] of rows) expect(communityWelcomeSays(view, facts, owner), what).toBe(says);
    });
});

describe("the community welcome's ×: one more entry in the layout's dismissed map, no new shape", () => {
    it('kept on a Home never saved as the default list with the entry, and on a saved Home with its cards untouched', () => {
        const fresh = dismissCommunityWelcome(null, NOW);
        expect(fresh.cards).toEqual(defaultHomeLayout().cards);
        expect(fresh.dismissed).toEqual({ [COMMUNITY_WELCOME_DISMISSED]: new Date(NOW).toISOString() });
        expect(fresh.updatedAt).toBe(new Date(NOW).toISOString());
        const saved: HomeLayoutV2 = { v: 2, cards: [{ id: 'market', type: 'market' }], dismissed: { safety: daysAgo(3) }, updatedAt: daysAgo(3), view: { columns: 1 } };
        const after = dismissCommunityWelcome(saved, NOW);
        expect(after.cards).toEqual(saved.cards);
        expect(after.view).toEqual(saved.view);
        expect(after.dismissed).toEqual({ safety: daysAgo(3), [COMMUNITY_WELCOME_DISMISSED]: new Date(NOW).toISOString() });
        // The node takes it: a key of at most 32 characters with a date, the shape every app already reads.
        expect(checkHomeLayout(after).ok).toBe(true);
        expect(COMMUNITY_WELCOME_DISMISSED.length).toBeLessThanOrEqual(32);
        // And the welcome then stays away.
        expect(communityWelcomeView(answer(), after, NOW)).toBeNull();
    });
});
