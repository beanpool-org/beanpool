/**
 * The example cards on a nearly empty Market (utils/example-listings.ts; Marty, 2026-09-27): on a node that asks for
 * them (`features.exampleListings`, the global profile), while fewer than EXAMPLES_UNTIL real listings are in view.
 * Never on a local community or a node that says nothing, never under a search or a filter, and never something that
 * can be tapped, opened, messaged or traded.
 *
 * The Market screen can't be drawn here (vitest.config.ts: logic, not screens), so the last block reads the screen's
 * and the component's source and checks that the cards are drawn only where the rule says, outside the list's data,
 * with no handler anywhere on them.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Device modules, stubbed at the boundary (vitest.config.ts), for node-profile.ts: the signer's random bytes and storage.
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((len: number) => new Uint8Array(len)) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) },
}));
import {
    EXAMPLES_UNTIL, EXAMPLE_LISTINGS, EXAMPLE_BADGE, EXAMPLES_NOTE, exampleListingsOn, showExampleListings, exampleLabel, exampleCardA11y,
} from '../example-listings';
import { readNodeProfile } from '../node-profile';

const GLOBAL = readNodeProfile({ profile: 'global', features: { beans: false, openJoin: true, exampleListings: true } })!;
const LOCAL = readNodeProfile({ profile: 'local', features: { beans: true, openJoin: false, exampleListings: false } })!;
// A node from before the switch says nothing about it.
const OLD_GLOBAL = readNodeProfile({ profile: 'global', features: { beans: false, openJoin: true } })!;
const OLD = readNodeProfile({})!;

/** The Market's inputs to the rule: what the screen passes (app/(tabs)/index.tsx). */
const market = (features: typeof GLOBAL.features | null, realInView: number, extra: Partial<{ narrowed: boolean; loaded: boolean }> = {}) =>
    showExampleListings({ on: exampleListingsOn(features), narrowed: false, loaded: true, realInView, ...extra });

describe('which node shows them', () => {
    it('the node\'s word is kept from the info answer, and only as a boolean', () => {
        expect(GLOBAL.features.exampleListings).toBe(true);
        expect(LOCAL.features.exampleListings).toBe(false);
        expect(OLD_GLOBAL.features.exampleListings).toBeUndefined();
        expect(readNodeProfile({ profile: 'global', features: { exampleListings: 'yes' } })!.features.exampleListings).toBeUndefined();
    });

    it('on the global community, with 0 and with EXAMPLES_UNTIL - 1 real listings; not at EXAMPLES_UNTIL or more', () => {
        expect(EXAMPLES_UNTIL).toBe(6);
        expect(market(GLOBAL.features, 0)).toBe(true);
        expect(market(GLOBAL.features, EXAMPLES_UNTIL - 1)).toBe(true);
        expect(market(GLOBAL.features, EXAMPLES_UNTIL)).toBe(false);
        expect(market(GLOBAL.features, 50)).toBe(false);
    });

    it('never on a local community, a node that says nothing, or before the phone knows the node', () => {
        for (const features of [LOCAL.features, OLD_GLOBAL.features, OLD.features, null]) {
            expect(market(features, 0)).toBe(false);
            expect(market(features, EXAMPLES_UNTIL - 1)).toBe(false);
        }
        expect(exampleListingsOn(undefined)).toBe(false);
    });

    it('never under a search or a filter (an example never answers one), nor before the first sync has landed', () => {
        expect(market(GLOBAL.features, 0, { narrowed: true })).toBe(false);
        expect(market(GLOBAL.features, 0, { loaded: false })).toBe(false);
    });
});

describe('what a card says', () => {
    it('3 or 4 everyday offers and needs, with no name, place, price, Beans or link', () => {
        expect(EXAMPLE_LISTINGS.length).toBeGreaterThanOrEqual(3);
        expect(EXAMPLE_LISTINGS.length).toBeLessThanOrEqual(4);
        expect(new Set(EXAMPLE_LISTINGS.map(e => e.type))).toEqual(new Set(['offer', 'need']));
        for (const e of EXAMPLE_LISTINGS) {
            expect(Object.keys(e).sort()).toEqual(['description', 'emoji', 'key', 'title', 'type']);
            expect(`${e.title} ${e.description}`).not.toMatch(/\bbeans?\b|🫘|Ʀ|\$|€|£|\d+\s*(km|m)\b|https?:|www\.|@/i);
        }
        expect(EXAMPLES_NOTE).toMatch(/not real listings/);
    });

    it('the badge says Example, and a screen reader hears that it is an example before anything else', () => {
        expect(EXAMPLE_BADGE).toBe('Example');
        for (const e of EXAMPLE_LISTINGS) {
            expect(exampleLabel(e)).toBe(`Example, not a real listing. ${e.type === 'offer' ? 'Offer' : 'Need'}: ${e.title}. ${e.description}`);
            const a11y = exampleCardA11y(e);
            expect(a11y).toEqual({ accessible: true, accessibilityRole: 'text', accessibilityLabel: exampleLabel(e) });
            expect(a11y).not.toHaveProperty('onPress');
        }
    });

    it('is the same words as the web app\'s, so a visitor and a member see the same examples', () => {
        const web = fs.readFileSync(path.resolve(__dirname, '../../../pwa/src/lib/example-listings.ts'), 'utf-8');
        for (const e of EXAMPLE_LISTINGS) {
            expect(web).toContain(`title: '${e.title}'`);
            expect(web).toContain(`description: '${e.description}'`);
        }
        expect(web).toContain(`export const EXAMPLES_UNTIL = ${EXAMPLES_UNTIL};`);
    });
});

describe('the Market screen draws them only where the rule says, and nothing on them responds', () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf-8');
    const screen = read('app/(tabs)/index.tsx');
    const component = read('components/ExampleListings.tsx');

    it('the rule is fed the list\'s own filters and its real posts in view, after the first sync', () => {
        expect(screen).toMatch(/const showExamples = showExampleListings\(\{\s*on: exampleListingsOn\(nodeProfile\?\.features\), narrowed: hasActiveFilters, loaded: firstSyncDone, realInView: filteredPosts\.length,\s*\}\);/);
        // hasActiveFilters counts a search as a filter.
        expect(screen).toMatch(/const hasActiveFilters = marketFiltersActive\(filterState\) \|\| searchQuery\.trim\(\)\.length > 0;/);
    });

    it('twice and only twice: above the welcome and its "+ Create First Post", and after the real listings', () => {
        expect(screen.match(/<ExampleListings \/>/g)).toHaveLength(2);
        expect(screen).toMatch(/\{showExamples && <ExampleListings \/>\}\s*<ActivityWaterfall onCreatePostPress=/);
        expect(screen).toMatch(/ListFooterComponent=\{showExamples && filteredPosts\.length > 0 \? <ExampleListings \/> : null\}/);
    });

    it('never in the list\'s data, so a search, a count or a tap on a row never meets one', () => {
        expect(screen).not.toMatch(/EXAMPLE_LISTINGS/);
        expect(screen).not.toMatch(/listData\.push\([^)]*[Ee]xample/);
    });

    it('the card has no handler: no Pressable, no onPress, no navigation', () => {
        expect(component).not.toMatch(/Pressable|Touchable|onPress|onLongPress|router|Link|Linking|Share/);
        expect(component).toMatch(/\{\.\.\.exampleCardA11y\(example\)\}/);
        expect(component).toMatch(/EXAMPLE_BADGE/);
    });

    it('only the Market uses them: the map, the phone\'s posts and search never see one', () => {
        const root = path.resolve(__dirname, '../..');
        const users: string[] = [];
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name.startsWith('.')) continue;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (/\.(ts|tsx)$/.test(entry.name) && /example-listings'|ExampleListings'/.test(fs.readFileSync(full, 'utf-8'))) {
                    users.push(path.relative(root, full).split(path.sep).join('/'));
                }
            }
        };
        for (const dir of ['app', 'components', 'services', 'utils']) walk(path.join(root, dir));
        expect(users.sort()).toEqual(['app/(tabs)/index.tsx', 'components/ExampleListings.tsx']);
    });
});
