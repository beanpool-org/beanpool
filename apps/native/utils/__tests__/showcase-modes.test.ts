/**
 * The showcase on the phone (scratch/global-node/DESIGN-global-showcase-fable.md §1, §4, W3): a node whose `showcase`
 * is on keeps Commons and Ledger in the tab strip and previews them from Example Valley; one that doesn't say hides
 * them as before. Modes per feature and per reader, never wider than the node.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((len: number) => new Uint8Array(len)) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) },
}));
import { readNodeProfile, hiddenTabsFor, effectiveFeatures, showcaseMode } from '../node-profile';
import { NO_BEANS_TERMS, noBeansTermsNote } from '../market-global';

const OFF = { beans: false, escrow: false, enterprises: false, decisions: false, invites: false };
const GLOBAL = readNodeProfile({ profile: 'global', features: { ...OFF, showcase: true } })!;
const GLOBAL_BEFORE = readNodeProfile({ profile: 'global', features: { ...OFF } })!;
const LOCAL_OFF = readNodeProfile({ profile: 'local', features: { beans: false, showcase: false } })!;
const LOCAL = readNodeProfile({ profile: 'local', features: { beans: true } })!;

describe('the showcase switch', () => {
    it('is kept from the info answer, and only as a boolean', () => {
        expect(GLOBAL.features.showcase).toBe(true);
        expect(GLOBAL_BEFORE.features.showcase).toBeUndefined();
        expect(readNodeProfile({ features: { showcase: 'yes' } })!.features.showcase).toBeUndefined();
    });

    it('hiddenTabsFor: none under showcase; Commons and Ledger hidden where Beans are off without it', () => {
        expect(hiddenTabsFor(GLOBAL.features)).toEqual([]);
        expect(hiddenTabsFor(GLOBAL_BEFORE.features)).toEqual(['projects', 'ledger']);
        expect(hiddenTabsFor(LOCAL_OFF.features)).toEqual(['projects', 'ledger']);
        expect(hiddenTabsFor(LOCAL.features)).toEqual([]);
        expect(hiddenTabsFor(null)).toEqual([]);
    });
});

describe('modes per feature and per reader', () => {
    it('global with showcase: every money feature previews', () => {
        for (const f of ['beans', 'escrow', 'enterprises', 'decisions', 'invites'] as const) expect(showcaseMode(f, GLOBAL.features)).toBe('preview');
    });

    it('a server from before the switch hides, as today; a local node is live', () => {
        expect(showcaseMode('beans', GLOBAL_BEFORE.features)).toBe('hidden');
        expect(showcaseMode('beans', LOCAL_OFF.features)).toBe('hidden');
        expect(showcaseMode('beans', LOCAL.features)).toBe('live');
        expect(showcaseMode('beans', null)).toBe('live');
    });

    it('a reader\'s own set decides, switch by switch (§4 pick 6, as #1845\'s featureModeFor); showcase stays the node\'s', () => {
        const node = { beans: true, decisions: true, showcase: true };
        expect(showcaseMode('decisions', node, { decisions: false })).toBe('read-only');
        expect(showcaseMode('beans', node, { beans: true })).toBe('live');
        // A verified member on global with Beans on for them: their Beans live, the rest still preview.
        expect(showcaseMode('beans', GLOBAL.features, { ...GLOBAL.features, beans: true })).toBe('live');
        expect(showcaseMode('decisions', GLOBAL.features, { ...GLOBAL.features, beans: true })).toBe('preview');
        expect(effectiveFeatures(GLOBAL.features, { beans: true }).beans).toBe(true);
        // A reader's answer that says nothing of a switch leaves the node's: mode and effective set agree.
        expect(showcaseMode('beans', GLOBAL.features, {})).toBe('preview');
        expect(effectiveFeatures(GLOBAL.features, {}).beans).toBe(false);
        expect(effectiveFeatures({ beans: true, showcase: true }, { beans: false, showcase: false })).toEqual({ beans: false, showcase: true });
        expect(effectiveFeatures(null)).toEqual({});
    });
});

describe('the Market\'s no-Beans words (design §1 row 2)', () => {
    it('say where Beans are, not that they are missing for good', () => {
        expect(noBeansTermsNote(true)).toMatch(/^No Beans here yet\. In a local community the price is in Beans, and the ledger remembers who helped whom\./);
        expect(noBeansTermsNote(true)).not.toMatch(/There are no Beans here|Ʀ|🔒|locked/i);
    });

    it("a local community whose operator turned Beans off keeps its own words: nothing there says 'in a local community' (review of #1852, finding 7)", () => {
        expect(noBeansTermsNote(false)).toBe(NO_BEANS_TERMS.note);
        expect(noBeansTermsNote(false)).toMatch(/^There are no Beans here\./);
        expect(noBeansTermsNote(false)).not.toMatch(/local community/i);
    });
});

describe("Home's first step and the Ledger's sample (design §1 rows 1 and 3)", () => {
    it('global First steps gains no "See how Beans work" line (the getting-started tour owns it); the Your Beans card shows where Beans are previewed', async () => {
        const { firstSteps, homeBeansPreview } = await import('../home-cards');
        const answer = {
            profile: 'global', features: { beans: false, showcase: true }, me: null,
            cards: { steps: { firstPost: false, joinedAt: new Date().toISOString() } },
        } as never;
        const steps = firstSteps(answer, { interests: [], role: 'member', knocked: false } as never);
        expect(steps.lines.map(l => l.id)).toEqual(['post']);
        expect(steps.lines.map(l => l.text).join(' ')).not.toMatch(/Beans/);
        expect(homeBeansPreview({ features: { beans: false, showcase: true } } as never)).toBe(true);
        expect(homeBeansPreview({ features: { beans: false } } as never)).toBe(false);
        expect(homeBeansPreview({ features: { beans: true, showcase: true } } as never)).toBe(false);
    });

    it("the member's own Ledger reads Example Valley in preview: 85 Beans, floor −200, level 2, six rows with the held deal's, no Ʀ", async () => {
        const { sampleBalance, sampleTransactions } = await import('../../components/showcase/sample-screens');
        const { memberLevel, SAMPLE_COMMUNITY: S } = await import('@beanpool/core');
        const b = sampleBalance();
        expect(b).toMatchObject({ balance: 85, floor: -200, frozen: false, activated: true, commons: 640, liveOffers: 1 });
        expect(memberLevel(b)).toEqual({ index: 1, credit: 200 });
        // The Levels card's figures are the sample's own, the ones the web's Ledger reads (one source in core).
        expect(b).toMatchObject({ tierCredit: S.trust, earnedCredit: S.trust, qualifiedValue: S.valueTraded,
            avgRating: S.rating, reviewCount: S.reviews, trustStats: { uniquePartners: S.partners } });
        const rows = sampleTransactions();
        expect(rows).toHaveLength(6);
        for (const r of rows) {
            expect(r.id).toMatch(/^sample-/);
            expect(r.amount).toBeGreaterThan(0);
            expect(r.peer).toMatch(/^(a neighbour|the Commons|the Example Valley Bakery)$/);
        }
        // No circulation fee row (a member at 85 Beans never pays one). The held deal's Beans went out to trust yesterday,
        // so its row is there, as on a node: "Held in trust · Fixing a bike puncture", 20 out, and it is In Escrow's 20.
        expect(rows.map(r => r.type)).toEqual(['credit', 'debit', 'debit', 'credit', 'credit', 'debit']);
        const held = S.deals.find(d => d.state === 'pending')!;
        expect(rows.filter(r => r.memo.startsWith('Held in trust'))).toEqual([
            { id: 'sample-tx-bike-held', type: 'debit', amount: held.amount, peer: 'a neighbour', memo: `Held in trust · ${held.what}`, timestamp: 'yesterday' },
        ]);
        expect(held.amount).toBe(S.inEscrow);
        expect(rows.some(r => /fee/i.test(r.memo))).toBe(false);
        expect(JSON.stringify([b, rows])).not.toMatch(/Ʀ/);
    });

    it('sampleInvites and sampleInviteTree read Example Valley for people.tsx in preview', async () => {
        const { sampleInvites, sampleInviteTree } = await import('../../components/showcase/sample-screens');
        const invites = sampleInvites();
        expect(invites.map(i => i.code)).toEqual(['EXAMPLE-1234', 'EXAMPLE-5678', 'EXAMPLE-9012']);
        expect(invites[0].usedBy).toBeNull();
        expect(invites[0].intendedFor).toBe('a neighbour');
        expect(invites[1].usedBy).toBe('sample-member-second');
        expect(invites[2].usedBy).toBe('sample-member-first');

        const tree = sampleInviteTree('test-pubkey');
        expect(tree).toHaveLength(1);
        expect(tree[0].publicKey).toBe('test-pubkey');
        expect(tree[0].callsign).toBe('an example member');
        expect(tree[0].children).toHaveLength(2);
        expect(tree[0].children.map(c => c.callsign)).toEqual(['a neighbour', 'a neighbour']);
    });
});
