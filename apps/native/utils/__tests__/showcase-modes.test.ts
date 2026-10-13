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
import { NO_BEANS_TERMS } from '../market-global';

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
        expect(NO_BEANS_TERMS.note).toMatch(/^No Beans here yet\. In a local community the price is in Beans, and the ledger remembers who helped whom\./);
        expect(NO_BEANS_TERMS.note).not.toMatch(/There are no Beans here|Ʀ|🔒|locked/i);
    });
});

describe("Home's first step and the Ledger's sample (design §1 rows 1 and 3)", () => {
    it('global First steps gains "See how Beans work ›" only where Beans are previewed', async () => {
        const { globalStepLines, homeBeansPreview } = await import('../home-cards');
        const steps = { firstPost: false } as never;
        expect(globalStepLines(steps, undefined, false, true).map(l => l.id)).toEqual(['post', 'beans']);
        expect(globalStepLines(steps, undefined, false, true)[1]).toMatchObject({ text: 'See how Beans work ›', done: false, suggestion: true });
        expect(globalStepLines(steps, undefined, false).map(l => l.id)).toEqual(['post']);
        expect(homeBeansPreview({ features: { beans: false, showcase: true } } as never)).toBe(true);
        expect(homeBeansPreview({ features: { beans: false } } as never)).toBe(false);
        expect(homeBeansPreview({ features: { beans: true, showcase: true } } as never)).toBe(false);
    });

    it("the member's own Ledger reads Example Valley in preview: 85 Beans, floor −200, level 2, six rows, no Ʀ", async () => {
        const { sampleBalance, sampleTransactions } = await import('../../components/showcase/sample-screens');
        const { memberLevel } = await import('@beanpool/core');
        const b = sampleBalance();
        expect(b).toMatchObject({ balance: 85, floor: -200, frozen: false, activated: true, commons: 640, liveOffers: 1 });
        expect(memberLevel(b).index).toBe(1);
        const rows = sampleTransactions();
        expect(rows).toHaveLength(6);
        for (const r of rows) {
            expect(r.id).toMatch(/^sample-/);
            expect(r.amount).toBeGreaterThan(0);
            expect(r.peer).toMatch(/^(a neighbour|the Commons|the Example Valley Bakery)$/);
        }
        expect(rows.map(r => r.type)).toEqual(['credit', 'debit', 'credit', 'debit', 'credit', 'debit']);
        expect(JSON.stringify([b, rows])).not.toMatch(/Ʀ/);
    });
});
