/**
 * The Home card rules (lib/home-cards.ts; DESIGN-home-dashboard-fable.md §3, §4, §12 H3 "the shared vitest cases"):
 * the catalogue, what each person in §3.2 sees (drawn on the card frame, `shownFrame`), interests ordering, and the words
 * the cards say. The member's list itself (add, remove, move, reset, which copy wins, what is asked) is
 * lib/home-layout.ts, proved in home-layout.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { FIND_COMMUNITY_WORDS, NEAR_COMMUNITY_KM, addDateWords, pluralKey, setLanguage } from '@beanpool/core';
import { dateWords as frDates } from '@beanpool/core/words-dates/fr';
import {
    HOME_CARD_IDS, SKY_NO_PLACE_LINE, beansLines, cardTitle, closesWords, communityFacts, communityLine, dealTitleLine, decideLine, enterpriseLatestLine, findBody, findListed, findOffersStart, joinedLine, monthSummaryLine, probationSentence, searchCardFor, shownFrame, skyOf,
    starredFirst, stepLines, stepsSaySomething, toggleInterest, usePhoneAppCardDue, type HomeAnswer, type HomeCards, type HomeMe, type ShownOptions,
} from './home-cards';
import { cardsToAsk, type HomeLayoutV2 } from './home-layout';

const NOW = Date.parse('2026-10-02T09:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const me = (over: Partial<HomeMe> = {}): HomeMe => ({
    joinedAt: daysAgo(1), isKeeper: false, probation: null, interests: [], area: null, firstOffer: false, standing: 'member', ...over,
});
const LOCAL_FEATURES = { beans: true, escrow: true, enterprises: true, invites: true, decisions: true, guestListingsOnly: false };
const GLOBAL_FEATURES = { beans: false, escrow: false, enterprises: false, invites: false, decisions: false, guestListingsOnly: true, exampleListings: true };

function answer(cards: HomeCards, over: Partial<HomeAnswer> = {}): HomeAnswer {
    return { generatedAt: new Date(NOW).toISOString(), profile: 'local', features: LOCAL_FEATURES, me: me(), layout: null, cards, ...over };
}

const find = { point: 'request' as const, communities: [{ key: 'k', name: 'Byron Shire BeanPool', url: 'https://byron.example', memberCount: 40, distanceKm: 12 }], communityCount: 38, nearbyPosts: { radiusKm: 25, count: 9, more: false }, watches: [], knock: null, directoryFetchedAt: null };
const steps = { joinedAt: daysAgo(1), firstOffer: false, firstPost: false, photo: false, interests: false, invited: false, area: false, knocked: null, saidHello: false, watch: false, sawLedger: false };
const market = { items: [{ id: 'p1', type: 'offer' as const, title: 'Sourdough', category: 'food', photoUrl: null }], total14d: 1, more: false };
const events = { items: [{ id: 'e1', title: 'Seed swap', startsAt: daysAgo(-1), endsAt: null, place: 'Town Hall', rsvp: null }], radiusKm: null };
const community = { name: 'Mullumbimby', members: 81, tradesThisMonth: 23 };
const pulse = { items: [{ id: 'u1', title: 'How our LETS started', thumbnailUrl: null, platform: 'youtube', callsign: 'River Folk', category: 'education', url: null }] };
const beans = { balance: 0, room: 0, tier: 'Newcomer', activated: false, frozen: false };

/** A list holding every card in the catalogue's order, as version 1 drew by default; `without` leaves some out. */
const every = (...without: string[]): HomeLayoutV2 => ({
    v: 2, cards: HOME_CARD_IDS.filter(id => id !== 'needs' && id !== 'community' && !without.includes(id)).map(id => ({ id, type: id })), dismissed: {}, updatedAt: null,
});
const shown = (a: HomeAnswer, opts: ShownOptions, layout: HomeLayoutV2 = every()) => shownFrame(a, layout, opts).map(c => c.type);

describe('the catalogue and the default order (§3.1)', () => {
    it('is the 18 ids in the design order (the 17 and Tips after First steps), community last', () => {
        expect(HOME_CARD_IDS).toEqual(['needs', 'safety', 'find', 'steps', 'tips', 'interests', 'deals', 'enterprise', 'events', 'market', 'decide', 'groups', 'joined', 'pulse', 'beans', 'notices', 'invite', 'community']);
    });
});

describe('what each person sees, top down (§3.2)', () => {
    it('(a) a new global member, a community 12 km away: find first, no money cards, no invite', () => {
        const a = answer({ find, steps, market, events, joined: { count7d: 14, radiusKm: 50 }, pulse, community: { name: null, members: 2310, communities: 38 } },
            { profile: 'global', features: GLOBAL_FEATURES, me: me({ firstOffer: true }) });
        expect(shown(a, { now: NOW })).toEqual(['find', 'steps', 'interests', 'events', 'market', 'joined', 'pulse', 'community']);
    });

    it('(a) a new global member by 12 words with nothing near: the safety card leads, examples in the Market card', () => {
        const a = answer({ safety: { words: true, signInLinked: false }, find: { ...find, communities: [] }, steps, market: { items: [], total14d: 0, more: false, examples: true }, community: { name: null, members: 4, communities: 0 } },
            { profile: 'global', features: GLOBAL_FEATURES });
        expect(shown(a, { now: NOW })).toEqual(['safety', 'find', 'steps', 'interests', 'market', 'community']);
    });

    it('(b) a new local member: steps, interests, then the community\'s cards and their own Beans', () => {
        const a = answer({ steps, events, market, joined: { count7d: 5, radiusKm: null, names: [{ callsign: 'Ana', avatarUrl: null }] }, pulse, beans, community });
        expect(shown(a, { now: NOW })).toEqual(['steps', 'interests', 'events', 'market', 'joined', 'pulse', 'beans', 'community']);
    });

    it('(b) an active trader: what waits first; no steps or interests once set; Invite after the first Offer', () => {
        const a = answer({
            needs: { items: [{ kind: 'deal', count: 1, accent: true, label: 'A deal is waiting for you: Sourdough', target: { to: 'deal', postId: 'p1', txId: 't1' } }] },
            deals: { open: 2, waiting: 1, waitingOnMe: { txId: 't1', postId: 'p1', title: 'Sourdough' } },
            events, market, decide: { open: 1, soonestClosesAt: daysAgo(-2), polls: 2, pollsMore: false },
            groups: { items: [{ id: 'g', kind: 'group', name: 'Garden Group', unread: 4, muted: false }], total: 1 }, pulse,
            beans: { balance: -35, room: 165, tier: 'Resident', activated: true, frozen: false }, community,
        }, { me: me({ joinedAt: daysAgo(90), interests: ['food'], firstOffer: true }) });
        expect(shown(a, { now: NOW })).toEqual(['needs', 'deals', 'events', 'market', 'decide', 'groups', 'pulse', 'beans', 'invite', 'community']);
    });

    it('(b) an enterprise keeper gets the enterprise card after deals', () => {
        const a = answer({ deals: { open: 1, waiting: 0, waitingOnMe: null }, enterprise: { id: 'x', name: 'Mullum Ceramics', requests: 3, others: 0 }, events, community },
            { me: me({ joinedAt: daysAgo(200), interests: ['arts'], isKeeper: true }) });
        expect(shown(a, { now: NOW })).toEqual(['deals', 'enterprise', 'events', 'community']);
    });

    it('(b) the operator of a brand-new node, alone: First steps and the community, nothing padded', () => {
        const a = answer({ steps, community: { name: 'New Town', members: 1, tradesThisMonth: 0 } });
        expect(shown(a, { now: NOW })).toEqual(['steps', 'interests', 'community']);
    });

    it('(c) a visitor in the global lobby: only the visitors\' cards, even if more were sent', () => {
        const a = answer({ find, market, events, pulse, joined: { count7d: 3, radiusKm: 50 }, community: { name: null, members: 2310, communities: 38 } },
            { profile: 'global', features: GLOBAL_FEATURES, welcome: true, me: null });
        expect(shown(a, { now: NOW })).toEqual(['find', 'events', 'market', 'community']);
    });

    it('a suspended member is never asked to tune or invite', () => {
        const a = answer({ community }, { me: me({ standing: 'suspended', firstOffer: true }) });
        expect(shown(a, { now: NOW })).toEqual(['community']);
    });

    it('a card the answer leaves out takes no space; the interests card follows the page\'s own interests and Tune', () => {
        const a = answer({ market, community });
        expect(shown(a, { now: NOW, interests: ['food'] })).toEqual(['market', 'community']);
        expect(shown(a, { now: NOW, interests: ['food'], interestsOpen: true })).toEqual(['interests', 'market', 'community']);
    });

    it('Tips is never asked of the node (no data: the address and its tag are what they were), and shows only for a member with a tip', () => {
        const a = answer({ community });
        expect(cardsToAsk(every())).not.toContain('tips');
        expect(cardsToAsk(every())).toEqual(cardsToAsk(every('tips')));
        expect(shown(a, { now: NOW, tipsUp: true })).toContain('tips');
        expect(shown(a, { now: NOW })).not.toContain('tips');
        expect(shown(a, { now: NOW, tipsUp: true }, every('tips'))).not.toContain('tips');
        expect(shown({ ...a, me: null }, { now: NOW, tipsUp: true })).not.toContain('tips');
    });
});

describe('interests reorder, they never filter (§4.3)', () => {
    const items = [{ c: 'tools' }, { c: 'food' }, { c: 'garden' }, { c: 'Food' }];

    it('starred categories first, each part in the order it came; nothing dropped', () => {
        expect(starredFirst(items, i => i.c, ['food']).map(i => i.c)).toEqual(['food', 'Food', 'tools', 'garden']);
        expect(starredFirst(items, i => i.c, ['energy'])).toEqual(items);
        expect(starredFirst(items, i => i.c, [])).toEqual(items);
    });

    it('a tap turns a chip on or off, keeping the order they were chosen in', () => {
        expect(toggleInterest(['food'], 'garden')).toEqual(['food', 'garden']);
        expect(toggleInterest(['food', 'garden'], 'food')).toEqual(['garden']);
    });
});

describe('the words (§3.1, §9)', () => {
    it('the card for the one you keep: "Your project" for a project, "Your enterprise" otherwise (group decisions §3.1)', () => {
        const ent = (lifecycle?: 'ongoing' | 'bounded') => ({ profile: 'local', cards: { enterprise: { id: 'e', name: 'Hall roof', requests: 0, others: 0, lifecycle } } });
        expect(cardTitle('enterprise', ent('bounded'))).toBe('Your project');
        expect(cardTitle('enterprise', ent('ongoing'))).toBe('Your enterprise');
        expect(cardTitle('enterprise', ent())).toBe('Your enterprise');
        expect(cardTitle('enterprise', { profile: 'local' })).toBe('Your enterprise');
    });

    it('steps card title: "Your first week" on global, "First steps" locally', () => {
        expect(cardTitle('steps', { profile: 'global' })).toBe('Your first week');
        expect(cardTitle('steps', { profile: 'local' })).toBe('First steps');
    });

    it('Beans: their own balance, plain for a new member, the tier as a word only', () => {
        expect(beansLines(beans)).toEqual({ line: '0 Beans · nothing to repay', note: 'Your credit opens with a first trade.' });
        expect(beansLines({ balance: -35, room: 165, tier: 'Resident', activated: true, frozen: false })).toEqual({ line: '−35 Beans · room to spend 165', note: 'Resident' });
        expect(beansLines({ balance: 1, room: 200, tier: 'Resident', activated: true, frozen: false }).line).toBe('1 Bean · room to spend 200');
        expect(beansLines({ balance: 12, room: 0, tier: 'Resident', activated: true, frozen: true }).line).toBe('12 Beans · spending paused');
    });

    it('Beans: a balance of a thousand or more is grouped in English with its cents too, as it always was', () => {
        const at = (balance: number) => beansLines({ balance, room: 2310, tier: 'Resident', activated: true, frozen: false }).line;
        expect(at(1234)).toBe('1,234 Beans · room to spend 2,310');
        expect(at(1234.5)).toBe('1,234.5 Beans · room to spend 2,310');
        expect(at(-1234.56)).toBe('−1,234.56 Beans · room to spend 2,310');
        expect(at(1234567.89)).toBe('1,234,567.89 Beans · room to spend 2,310');
        expect(at(-0.5)).toBe('−0.5 Beans · room to spend 2,310');
        expect(at(12.5)).toBe('12.5 Beans · room to spend 2,310');
        // Elsewhere amounts are the digits alone, with the language's decimal separator (core formatNumber).
        addDateWords('fr', frDates);
        setLanguage('fr');
        try {
            expect(at(1234.5).startsWith('1234,5 ')).toBe(true);
            expect(at(-0.5).startsWith('−0,5 ')).toBe(true);
        } finally {
            setLanguage('en');
        }
    });

    it('a vote closing, in the member\'s own time', () => {
        const at = (d: number, h: number) => { const x = new Date(NOW); x.setDate(x.getDate() + d); x.setHours(h, 0, 0, 0); return x.toISOString(); };
        const morning = (() => { const x = new Date(NOW); x.setHours(8, 0, 0, 0); return x.getTime(); })();
        expect(closesWords(at(0, 20), morning)).toBe('closes tonight');
        expect(closesWords(at(0, 12), morning)).toBe('closes today');
        expect(closesWords(at(1, 12), morning)).toBe('closes tomorrow');
        expect(closesWords(at(3, 12), morning)).toMatch(/^closes (Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/);
        expect(closesWords(at(10, 12), morning)).toMatch(/^closes \d{1,2} [A-Z][a-z]{2}$/);
    });

    it('Decide, Who joined and the community, with real numbers only', () => {
        expect(decideLine({ open: 0, soonestClosesAt: null, polls: 2, pollsMore: false })).toBe('2 polls open');
        expect(decideLine({ open: 0, soonestClosesAt: null, polls: 50, pollsMore: true })).toBe('50+ polls open');
        expect(joinedLine({ count7d: 5, radiusKm: null, names: [{ callsign: 'Ana', avatarUrl: null }, { callsign: 'Kofi', avatarUrl: null }] })).toBe('Ana, Kofi and 3 more joined this week.');
        expect(joinedLine({ count7d: 1, radiusKm: null, names: [{ callsign: 'Ana', avatarUrl: null }] })).toBe('Ana joined this week.');
        expect(joinedLine({ count7d: 14, radiusKm: 50 })).toBe('14 people within 50 km joined this week.');
        expect(communityLine(community, 'local')).toBe('81 members · 23 trades this month');
        expect(communityLine({ name: null, members: 2310, communities: 38 }, 'global')).toBe('2,310 members · 38 communities listed');
    });

    it('the find card says what the node found, and nothing it did not', () => {
        expect(findBody(find)).toBe('The community nearest you. Ask to join, and trade with your neighbours there.');
        expect(findBody({ ...find, communities: [...find.communities, { ...find.communities[0], key: 'k2', distanceKm: 39 }] }))
            .toBe('The communities nearest you, closest first. Ask one to let you in, and trade with your neighbours there.');
        expect(communityFacts(find.communities[0])).toBe('12 km away · 40 members');
        expect(communityFacts({ distanceKm: 4.62, memberCount: 1 })).toBe('4.6 km away · 1 member');
        expect(communityFacts({ distanceKm: 0.4, memberCount: null })).toBe('Less than 1 km away');
        expect(findBody({ ...find, communities: [], point: null, communityCount: 1 })).toBe('1 community is listed. Share your area, or type your town, to see the nearest.');
        // "None" only once the directory has loaded (privacy review M3): before the node's first fetch an empty answer
        // (communities [], count 0, directoryFetchedAt null, as measured) is unknown, and no "none" is said.
        const NOT_LOADED = "The list of communities isn't available right now. Try again soon.";
        expect(findBody({ ...find, communities: [], communityCount: 0 })).toBe(NOT_LOADED);
        expect(findBody({ ...find, communities: [], point: null, communityCount: 0 })).toBe(NOT_LOADED);
        expect(findBody({ ...find, communities: [] })).toBe(NOT_LOADED);
        const loaded = { ...find, directoryFetchedAt: '2026-10-14T08:00:00.000Z' };
        // One "none" sentence, and nothing the web can't do ("ask to be told" is the phone's).
        expect(findBody({ ...loaded, communities: [], communityCount: 0 })).toBe('No community near you yet.');
        expect(findBody({ ...loaded, communities: [], point: null, communityCount: 0 })).toBe('No community near you yet.');
        expect(findBody({ ...loaded, communities: [] })).toBe('No community near you yet.');
        // A count the node didn't send is unknown, never 0.
        expect(findBody({ ...loaded, communities: [], point: null, communityCount: null })).toBe('Share your area, or type your town, to see the nearest.');
    });

    it('far is not near: Lismore at 12,489 km is listed with its distance, under "No community near you yet" (rehearsal B2)', () => {
        const loaded = { ...find, directoryFetchedAt: '2026-10-14T08:00:00.000Z' };
        const lismore = { key: 'l', name: 'Lismore', url: 'https://lismore.example', memberCount: 12, distanceKm: 12_489 };
        expect(findBody({ ...loaded, communities: [lismore] })).toBe('No community near you yet. The nearest listed is far from here:');
        expect(findBody({ ...loaded, communities: [lismore, { ...lismore, key: 'm', distanceKm: 12_530 }] })).toBe('No community near you yet. The nearest listed are far from here:');
        expect(communityFacts(lismore)).toBe('12,489 km away · 12 members');
        // Start a community beside "none" and "far" only: not while near, not before the list has loaded.
        expect(findOffersStart({ ...loaded, communities: [lismore] })).toBe(true);
        expect(findOffersStart({ ...loaded, communities: [], communityCount: 0 })).toBe(true);
        expect(findOffersStart(loaded)).toBe(false);
        expect(findOffersStart({ ...find, communities: [], communityCount: 0 })).toBe(false);
        expect(findOffersStart({ ...loaded, communities: [], point: null, communityCount: 38 })).toBe(false);
        // 250 km is near; just past it is not.
        expect(findBody({ ...loaded, communities: [{ ...lismore, distanceKm: 250 }] })).toBe('The community nearest you. Ask to join, and trade with your neighbours there.');
        expect(findOffersStart({ ...loaded, communities: [{ ...lismore, distanceKm: 251 }] })).toBe(true);
    });

    it('"none" and the far line are one language: both halves through t() (deciding review of #2152)', () => {
        const loaded = { ...find, directoryFetchedAt: '2026-10-14T08:00:00.000Z' };
        const lismore = { key: 'l', name: 'Lismore', url: 'https://lismore.example', memberCount: 12, distanceKm: 12_489 };
        // A French catalog that gives every key a value (the drafting pass will write the real ones).
        setLanguage('fr', [{
            [FIND_COMMUNITY_WORDS.noneNear]: 'Aucune communauté près de chez vous pour l’instant.',
            [FIND_COMMUNITY_WORDS.notLoaded]: 'La liste des communautés n’est pas disponible. Réessayez bientôt.',
            [pluralKey('The nearest listed is far from here:', 'The nearest listed are far from here:')]: { one: 'La plus proche est loin d’ici :', other: 'Les plus proches sont loin d’ici :' },
        }]);
        try {
            expect(findBody({ ...loaded, communities: [lismore] })).toBe('Aucune communauté près de chez vous pour l’instant. La plus proche est loin d’ici :');
            expect(findBody({ ...loaded, communities: [lismore, { ...lismore, key: 'm', distanceKm: 12_530 }] })).toBe('Aucune communauté près de chez vous pour l’instant. Les plus proches sont loin d’ici :');
            expect(findBody({ ...loaded, communities: [], communityCount: 0 })).toBe('Aucune communauté près de chez vous pour l’instant.');
            expect(findBody({ ...find, communities: [] })).toBe('La liste des communautés n’est pas disponible. Réessayez bientôt.');
        } finally {
            setLanguage('en');
        }
    });

    it('near: only communities within 250 km are called nearest you or listed under it (#1935 finding 2)', () => {
        const loaded = { ...find, directoryFetchedAt: '2026-10-14T08:00:00.000Z' };
        const lismore = { key: 'l', name: 'Lismore', url: 'https://lismore.example', memberCount: 12, distanceKm: 12 };
        const byron = { ...lismore, key: 'b', name: 'Byron', distanceKm: 12_525 };
        const nimbin = { ...lismore, key: 'n', name: 'Nimbin', distanceKm: 40 };
        // The review's render: "The communities nearest you, closest first" over Byron at 12,525 km.
        expect(findBody({ ...loaded, communities: [lismore, byron] })).toBe('The community nearest you. Ask to join, and trade with your neighbours there.');
        expect(findListed({ ...loaded, communities: [lismore, byron] }).map(c => c.key)).toEqual(['l']);
        expect(findBody({ ...loaded, communities: [lismore, nimbin, byron] }))
            .toBe('The communities nearest you, closest first. Ask one to let you in, and trade with your neighbours there.');
        expect(findListed({ ...loaded, communities: [lismore, nimbin, byron] }).map(c => c.key)).toEqual(['l', 'n']);
        // Far: the nearest listed, each with its distance, at most 3.
        const far = [byron, { ...byron, key: 'b2', distanceKm: 12_600 }, { ...byron, key: 'b3', distanceKm: 13_000 }, { ...byron, key: 'b4', distanceKm: 14_000 }];
        expect(findListed({ ...loaded, communities: far }).map(c => c.key)).toEqual(['b', 'b2', 'b3']);
    });

    it('the new-account limits from the node\'s own numbers: 3 days by sign-in, 7 by 12 words', () => {
        const p = (hours: number, posts: number, chats: number) => ({ onProbation: true, ageEndsAt: null, keptPosts: 0, keptPostsNeeded: 3, endsWhen: { hours, keptPosts: 3 }, limits: { posts: { limit: posts }, photos: { limit: 5 }, new_dm_recipients: { limit: chats } } });
        expect(probationSentence(p(72, 3, 10))).toBe('For your first 3 days: 3 posts and 10 new chats a day.');
        expect(probationSentence(p(168, 2, 3))).toBe('For your first 7 days: 2 posts and 3 new chats a day.');
        expect(probationSentence(null)).toBeNull();
        expect(probationSentence({ ...p(72, 3, 10), onProbation: false })).toBeNull();
    });
});

describe('The first week on the web (L3, §3.2)', () => {
    const august = '2026-08-10T00:00:00.000Z';
    const allDoneSteps = { area: true, photo: true, sawLedger: true, firstPost: true, saidHello: true, watch: true };
    const globalMember = (stepsOver: Partial<typeof steps>, findCard = { ...find, communities: [] as typeof find.communities }, meOver: Partial<HomeMe> = {}) =>
        answer({ find: findCard, steps: { ...steps, joinedAt: august, area: false, ...stepsOver }, community },
            { profile: 'global', features: GLOBAL_FEATURES, me: me({ joinedAt: august, interests: ['food'], ...meOver }) });

    it('the seven steps of §3.2 on global', () => {
        const a = globalMember({});
        expect(stepLines(a, ['food'])).toEqual([
            { key: 'name', done: true, text: 'Choose a name' },
            { key: 'area', done: false, text: 'Say roughly where you are' },
            { key: 'photo', done: false, text: 'Add a picture (a preset counts)' },
            { key: 'sawLedger', done: false, text: 'Look at an example Ledger' },
            { key: 'firstPost', done: false, text: 'Post something free or for swap' },
            { key: 'saidHello', done: false, text: 'Say hello to someone near you' },
            { key: 'watch', done: false, text: "Tell me when a community starts here, or say you'd help start one" },
        ]);
    });

    it('card ends after 14 days or all done on global', () => {
        // More than 14 days old, undone: web leaves it out
        const oldUndone = globalMember({ firstPost: true });
        expect(stepsSaySomething(oldUndone, ['food'], NOW)).toBe(false);
        expect(shown(oldUndone, { now: NOW })).not.toContain('steps');

        // Young (< 14 days), undone: web shows it
        const youngUndone = globalMember({ firstPost: true, joinedAt: daysAgo(3) }, find, { joinedAt: daysAgo(3) });
        expect(stepsSaySomething(youngUndone, ['food'], NOW)).toBe(true);
        expect(shown(youngUndone, { now: NOW })).toContain('steps');

        // Young (< 14 days), all done: card ends immediately
        const youngAllDone = globalMember({ ...allDoneSteps, joinedAt: daysAgo(3) }, find, { joinedAt: daysAgo(3) });
        expect(stepsSaySomething(youngAllDone, ['food'], NOW)).toBe(false);
        expect(shown(youngAllDone, { now: NOW })).not.toContain('steps');

        // More than 14 days old, all done: card ends
        const oldAllDone = globalMember({ ...allDoneSteps, joinedAt: august }, find, { joinedAt: august });
        expect(stepsSaySomething(oldAllDone, ['food'], NOW)).toBe(false);
        expect(shown(oldAllDone, { now: NOW })).not.toContain('steps');
    });

    it('locally, by the same lines: a chip tapped ticks "Pick a few things you like" at once', () => {
        const a = answer({ steps: { ...steps, joinedAt: august, firstOffer: true, photo: true, interests: false, invited: true }, community },
            { me: me({ joinedAt: august, firstOffer: true }) });
        expect(shown(a, { now: NOW, interests: [] })).toContain('steps');
        expect(shown(a, { now: NOW, interests: ['food'] })).not.toContain('steps');
    });
});

describe("a saved search's body (slice F4): only the node's answer for the words the card holds now", () => {
    const inst = { id: 'search-k7mq', settings: { q: 'eggs', kind: 'any', km: 5 } };
    const body = { q: 'eggs', kind: 'any', category: null, km: 5, more: true, items: [{ id: 'p1', type: 'offer', title: 'Fresh eggs', category: 'food', photoUrl: null }] };
    const withCard = (c: unknown) => ({ cards: { 'search-k7mq': c } } as unknown as HomeAnswer);

    it("reads the node's rows and more for these words", () => {
        expect(searchCardFor(withCard(body), inst)).toEqual(body);
    });

    it('a kept answer for other words, an odd body or none is no body (the card says it shows when the community answers)', () => {
        expect(searchCardFor(withCard({ ...body, q: 'rye' }), inst)).toBeNull();
        expect(searchCardFor(withCard({ q: 'eggs' }), inst)).toBeNull();
        expect(searchCardFor(withCard('eggs'), inst)).toBeNull();
        expect(searchCardFor({ cards: {} } as unknown as HomeAnswer, inst)).toBeNull();
        expect(searchCardFor(null, inst)).toBeNull();
    });

    it('an absent km is none, an absent more is false', () => {
        expect(searchCardFor(withCard({ q: 'eggs', items: [] }), inst)).toEqual({ q: 'eggs', kind: 'any', category: null, km: null, items: [], more: false });
    });

    it('a kept answer for another kind, category or distance is no body; km null (the node had no point) still answers (review of #1716, finding 2)', () => {
        expect(searchCardFor(withCard({ ...body, kind: 'offer' }), inst)).toBeNull();
        expect(searchCardFor(withCard({ ...body, category: 'food' }), inst)).toBeNull();
        expect(searchCardFor(withCard({ ...body, km: 25 }), inst)).toBeNull();
        expect(searchCardFor(withCard(body), { ...inst, settings: { q: 'eggs', kind: 'need', km: 5 } })).toBeNull();
        expect(searchCardFor(withCard(body), { ...inst, settings: { q: 'eggs', kind: 'any', category: 'tools', km: 5 } })).toBeNull();
        expect(searchCardFor(withCard(body), { ...inst, settings: { q: 'eggs', kind: 'any' } })).toBeNull();
        expect(searchCardFor(withCard({ ...body, km: null }), { ...inst, settings: { q: 'eggs', kind: 'any', km: 25 } })).toEqual({ ...body, km: null });
        const tools = { ...body, kind: 'need', category: 'tools', km: 10 };
        expect(searchCardFor(withCard(tools), { ...inst, settings: { q: 'eggs', kind: 'need', category: 'tools', km: 10 } })).toEqual(tools);
    });
});

describe('sun and moon (CARD-FRAME §4, §5.2 item 22): worked out here, from the place the answer holds', () => {
    const MULLUM = { lat: -28.55, lng: 153.5 };
    const AREA = { lat: -37.07, lng: 144.22 };
    const withSky = (settings?: Record<string, unknown>): HomeLayoutV2 => ({ v: 2, cards: [{ id: 'sky', type: 'sky', ...(settings ? { settings } : {}) }, { id: 'market', type: 'market' }], dismissed: {}, updatedAt: null });
    const placed = (c: typeof MULLUM | null, area: typeof MULLUM | null) => answer({ market, community: { ...community, ...(c ? { place: c } : {}) } }, { me: me({ area }) });

    it("the community's place, else the member's area; 'me' puts the member's first; the browser's own location never", () => {
        expect(skyOf(placed(MULLUM, AREA), {}, NOW)!.place).toEqual(MULLUM);
        expect(skyOf(placed(null, AREA), {}, NOW)!.place).toEqual(AREA);
        expect(skyOf(placed(MULLUM, AREA), { settings: { place: 'me' } }, NOW)!.place).toEqual(AREA);
        expect(skyOf(placed(MULLUM, null), { settings: { place: 'me' } }, NOW)!.place).toEqual(MULLUM);
        expect(skyOf(placed(null, null), {}, NOW)).toBeNull();
        expect(SKY_NO_PLACE_LINE).toBe('Nothing to show now: no place is known.');
    });

    it('is drawn only where a place is known, and is never asked of the node', () => {
        expect(shown(placed(MULLUM, null), { now: NOW }, withSky())).toEqual(['sky', 'market', 'community']);
        expect(shown(placed(null, AREA), { now: NOW }, withSky())).toContain('sky');
        expect(shown(placed(null, null), { now: NOW }, withSky())).not.toContain('sky');
        expect(cardsToAsk(withSky(), [], { profile: 'local', features: LOCAL_FEATURES as never, cards: {} })).not.toContain('sky');
    });
});

describe('a pinned Find your community on the web (#1517, Lounge L1)', () => {
    const written = (...types: string[]): HomeLayoutV2 => ({ v: 2, cards: types.map(id => ({ id, type: id })), dismissed: {}, updatedAt: daysAgo(0) });
    const global = (days: number, overFind: Record<string, unknown> = {}) => answer(
        { safety: { words: true, signInLinked: false }, find: { ...find, ...overFind }, steps: { ...steps, joinedAt: daysAgo(days) }, market, events, community: { name: null, members: 2310, communities: 38 } },
        { profile: 'global', features: GLOBAL_FEATURES, me: me({ joinedAt: daysAgo(days), interests: ['food'] }) },
    );
    const watching = (days: number) => global(days, { watches: [{ point: 'area', radiusKm: 25 }] });

    it('sits right under Needs you and "Your way back in", while a knock or watch is open (Lounge L1)', () => {
        // Moved to the bottom, "Your way back in" further down: under Needs you.
        expect(shown(watching(3), { now: NOW }, written('market', 'events', 'steps', 'safety', 'find'))).toEqual(['find', 'market', 'events', 'steps', 'safety', 'community']);
        // "Your way back in" keeps its place at the top: under it.
        expect(shown(watching(3), { now: NOW }, written('safety', 'market', 'find'))).toEqual(['safety', 'find', 'market', 'community']);
        // Left out of the list (removed on a copy that saw no pin), or listed twice: once, at the top.
        expect(shown(watching(3), { now: NOW }, written('market', 'events'))).toEqual(['find', 'market', 'events', 'community']);
        expect(shown(watching(3), { now: NOW }, written('market', 'find', 'events', 'find'))).toEqual(['find', 'market', 'events', 'community']);
        // The same on day 40 with an open knock: still pinned (L1 requirement).
        expect(shown(global(40), { now: NOW, hasOpenKnock: true }, written('events', 'find', 'market'))).toEqual(['find', 'events', 'market', 'community']);
    });

    it('without an open knock or watch it is a card like any other: drawn where the list puts it', () => {
        expect(shown(global(3), { now: NOW }, written('market', 'find', 'events'))).toEqual(['market', 'find', 'events', 'community']);
        expect(shown(global(3), { now: NOW }, written('market', 'events'))).toEqual(['market', 'events', 'community']);
        expect(shown(global(40), { now: NOW }, written('market', 'find', 'events'))).toEqual(['market', 'find', 'events', 'community']);
    });
});

describe('enterprise latest line: positive incoming ("from"), negative outgoing ("to")', () => {
    it('member: positive incoming is "from", negative outgoing is "to"', () => {
        expect(enterpriseLatestLine({ kind: 'member', amount: 12, who: 'Ana', at: '' })).toBe('Latest: +12 Beans from Ana');
        expect(enterpriseLatestLine({ kind: 'member', amount: -50, who: 'Ana', at: '' })).toBe('Latest: −50 Beans to Ana');
        expect(enterpriseLatestLine({ kind: 'member', amount: -1, who: 'Ana', at: '' })).toBe('Latest: −1 Bean to Ana');
    });

    it('deal / escrow: positive is "from escrow", negative is "to escrow"', () => {
        expect(enterpriseLatestLine({ kind: 'deal', amount: 25, who: null, at: '' })).toBe('Latest: +25 Beans from escrow');
        expect(enterpriseLatestLine({ kind: 'deal', amount: -25, who: null, at: '' })).toBe('Latest: −25 Beans to escrow');
    });

    it('commons: positive is "from Commons", negative is "to Commons"', () => {
        expect(enterpriseLatestLine({ kind: 'commons', amount: 10, who: null, at: '' })).toBe('Latest: +10 Beans from Commons');
        expect(enterpriseLatestLine({ kind: 'commons', amount: -10, who: null, at: '' })).toBe('Latest: −10 Beans to Commons');
    });
});

describe('deal title line: deleted listing fallback label', () => {
    it('deleted listing with empty title falls back to Deal without dangling · with or blank row', () => {
        expect(dealTitleLine({ txId: '1', postId: 'p1', title: '', with: 'Ana', waitsOnMe: false, at: null })).toBe('Deal · with Ana');
        expect(dealTitleLine({ txId: '1', postId: 'p1', title: '', with: null, waitsOnMe: false, at: null })).toBe('Deal');
    });
});

describe('month summary line: partial month indication when more is set', () => {
    it('shows exact monthly figures when more is falsy', () => {
        expect(monthSummaryLine({ trades: 3, in: 40, out: 25 })).toBe('This month: 3 trades · +40 in · −25 out');
        expect(monthSummaryLine({ trades: 3, in: 40, out: 25, more: false })).toBe('This month: 3 trades · +40 in · −25 out');
    });

    it('shows partial indicator when more is true', () => {
        expect(monthSummaryLine({ trades: 200, in: 500, out: 300, more: true })).toBe('This month (partial): 200 trades · +500 in · −300 out');
    });
});

describe('usePhoneAppCardDue (front doors S4)', () => {
    it('is not due when dismissed', () => {
        expect(usePhoneAppCardDue({ dismissed: true, keptPosts: 2, weekOverAt: 1000, now: 2000 })).toBe(false);
    });

    it('is not due before first post and before week is over', () => {
        expect(usePhoneAppCardDue({ dismissed: false, keptPosts: 0, weekOverAt: 2000, now: 1000 })).toBe(false);
        expect(usePhoneAppCardDue({ dismissed: false, keptPosts: 0, weekOverAt: null, now: 1000 })).toBe(false);
    });

    it('is due after first post', () => {
        expect(usePhoneAppCardDue({ dismissed: false, keptPosts: 1, weekOverAt: 2000, now: 1000 })).toBe(true);
        expect(usePhoneAppCardDue({ dismissed: false, keptPosts: 5, weekOverAt: null, now: 1000 })).toBe(true);
    });

    it('is due after first week is over', () => {
        expect(usePhoneAppCardDue({ dismissed: false, keptPosts: 0, weekOverAt: 1000, now: 1000 })).toBe(true);
        expect(usePhoneAppCardDue({ dismissed: false, keptPosts: 0, weekOverAt: 1000, now: 2000 })).toBe(true);
    });
});
