import { describe, expect, it } from 'vitest';
import { SAMPLE_COMMUNITY, SAMPLE_ID_PREFIX, isSampleId } from '../sample-community.js';
import {
    LOCAL_COMMUNITY_LINES, LOCAL_COMMUNITY_SHEET, LOCAL_COMMUNITY_STRIP, SHOWCASE_FEATURES, featureMode, featureModeFor,
} from '../features.js';

/** Every [path, value] in a value, depth first. */
function walk(value: unknown, path = '$'): [string, unknown][] {
    if (value && typeof value === 'object') {
        return [[path, value], ...Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => walk(v, `${path}.${k}`))];
    }
    return [[path, value]];
}
const strings = (value: unknown) => walk(value).filter(([, v]) => typeof v === 'string') as [string, string][];

describe('the sample community (design §2): Example Valley, frozen', () => {
    it('is frozen all the way down', () => {
        const objects = walk(SAMPLE_COMMUNITY).filter(([, v]) => v && typeof v === 'object');
        expect(objects.length).toBeGreaterThan(10);
        for (const [path, v] of objects) expect(Object.isFrozen(v), path).toBe(true);
        expect(() => { (SAMPLE_COMMUNITY as any).balance = 1_000_000; }).toThrow();
        expect(() => { (SAMPLE_COMMUNITY.transactions as any).push({}); }).toThrow();
        expect(SAMPLE_COMMUNITY.balance).toBe(85);
    });

    it('holds the design\'s numbers: 85 Beans, room 285 down to −200, level 2 of 4, six rows, two deals, pool 640', () => {
        const s = SAMPLE_COMMUNITY;
        expect(s.name).toBe('Example Valley');
        expect([s.balance, s.floor, s.roomToSpend, s.liveOffers, s.level, s.levels, s.pool]).toEqual([85, -200, 285, 1, 2, 4, 640]);
        expect(s.roomToSpend).toBe(s.balance - s.floor);
        expect(s.transactions.map(t => t.amount)).toEqual([12, -40, 30, -0.9, 5, -18]);
        expect(s.deals.map(d => d.status).sort()).toEqual(['done', 'waiting-on-you']);
        expect(s.enterprises).toHaveLength(1);
        expect(s.enterprises[0]).toMatchObject({ name: 'Example Valley Bakery', keepers: 3, season: 120 });
        expect(s.decisions[0]).toMatchObject({ fromPool: 40, closesInDays: 3, votesFor: 12, votesAgainst: 2 });
    });

    it('every id is a sample id, and every sample id is unique', () => {
        const ids = walk(SAMPLE_COMMUNITY).filter(([p]) => /\.id$/.test(p)).map(([, v]) => v);
        expect(ids.length).toBe(1 + 6 + 2 + 1 + 1);
        for (const id of ids) {
            expect(typeof id === 'string' && id.startsWith(SAMPLE_ID_PREFIX), String(id)).toBe(true);
            expect(isSampleId(id), String(id)).toBe(true);
        }
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('has no @, no URL, no key and no real-looking name anywhere', () => {
        const all = strings(SAMPLE_COMMUNITY);
        expect(all.length).toBeGreaterThan(20);
        for (const [path, v] of all) {
            expect(v, path).not.toMatch(/@/);
            expect(v, path).not.toMatch(/https?:|www\.|:\/\/|\.(com|org|net|au|io|nz|uk)\b/i);
            expect(v, path).not.toMatch(/[0-9a-f]{32,}/i);
            expect(v, path).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}/);
        }
        // Who a row is with, and whose ledger it is: never a person's name.
        const PEOPLE = new Set(['a neighbour', 'the Commons', 'the Example Valley Bakery']);
        for (const [path, v] of all.filter(([p]) => /\.who$/.test(p))) expect(PEOPLE.has(v), `${path}: ${v}`).toBe(true);
        expect(SAMPLE_COMMUNITY.member).toBe('an example member');
        // No capitalised word but the sentence's first and the sample's own, so nothing reads as a person or a place.
        const ALLOWED = new Set(['Example', 'Valley', 'Bakery', 'Commons', 'Beans']);
        for (const [path, v] of all.filter(([p]) => !/\.id$/.test(p))) {
            const words = v.split(/\s+/).slice(1).filter(w => /^[A-Z]/.test(w));
            for (const w of words) expect(ALLOWED.has(w.replace(/[^A-Za-z]/g, '')), `${path}: "${w}" in "${v}"`).toBe(true);
        }
    });
});

describe('isSampleId: what the server\'s write guard refuses', () => {
    it('takes the sample shape only', () => {
        for (const v of ['sample-tx-bread', 'sample-1', 'sample-decision-compost-bay']) expect(isSampleId(v), v).toBe(true);
        for (const v of ['sample-', 'Sample-tx', 'sample tx', 'a sample-tx', 'sample-tx bread', 'sample-Tx', 'sample--x', 'resample-1', '', 42, null, undefined, {}, ['sample-1']]) {
            expect(isSampleId(v), JSON.stringify(v)).toBe(false);
        }
    });
});

describe('feature modes (design §4): live, preview, read-only, hidden', () => {
    it('the mode table, all eight rows', () => {
        const rows: [boolean, boolean, boolean, string][] = [
            // showcase, node, effective → mode
            [false, false, false, 'hidden'],
            [true, false, false, 'preview'],
            [false, true, false, 'read-only'],
            [true, true, false, 'read-only'],
            [false, true, true, 'live'],
            [true, true, true, 'live'],
            [false, false, true, 'live'],
            [true, false, true, 'live'],
        ];
        for (const [showcase, node, effective, mode] of rows) {
            expect(featureMode({ showcase, node, effective }), JSON.stringify({ showcase, node, effective })).toBe(mode);
        }
    });

    it('reads the node\'s and the reader\'s features: a missing switch is on, a missing showcase is today\'s hiding', () => {
        const local = { beans: true, escrow: true, enterprises: true, decisions: true, invites: true };
        const global = { beans: false, escrow: false, enterprises: false, decisions: false, invites: false };
        for (const f of SHOWCASE_FEATURES) {
            expect(featureModeFor(f, local), f).toBe('live');
            expect(featureModeFor(f, local, local), f).toBe('live');
            // A global node from before the switch: hidden, as today.
            expect(featureModeFor(f, global), f).toBe('hidden');
            expect(featureModeFor(f, { ...global, showcase: true }), f).toBe('preview');
            expect(featureModeFor(f, { ...global, showcase: true }, global), f).toBe('preview');
            // On for the node, off for this reader (BeanID later): read-only, with or without the showcase.
            expect(featureModeFor(f, { ...local, showcase: true }, { ...local, [f]: false }), f).toBe('read-only');
            expect(featureModeFor(f, local, { ...local, [f]: false }), f).toBe('read-only');
            // A local node whose operator turned one off: hidden.
            expect(featureModeFor(f, { ...local, [f]: false }), f).toBe('hidden');
        }
        // An old server's features without decisions or invites: on, as the apps read them.
        expect(featureModeFor('decisions', { beans: true })).toBe('live');
        expect(featureModeFor('invites', null)).toBe('live');
    });
});

describe('the marker and the sheet words (design §1, §2)', () => {
    it('one sheet line and guide page per feature, and the three ways forward', () => {
        for (const f of SHOWCASE_FEATURES) {
            expect(LOCAL_COMMUNITY_SHEET.features[f].length, f).toBeGreaterThan(20);
            expect(LOCAL_COMMUNITY_SHEET.guide[f], f).toMatch(/^[a-z0-9-]+$/);
            expect(LOCAL_COMMUNITY_STRIP.lead[f], f).toMatch(/from a local community\.$/);
        }
        expect([LOCAL_COMMUNITY_SHEET.start, LOCAL_COMMUNITY_SHEET.nearYou, LOCAL_COMMUNITY_SHEET.howItWorks])
            .toEqual(['Start a community', 'Communities near you', 'How it works']);
        expect(LOCAL_COMMUNITY_SHEET.title).toBe('Why this lives in a local community');
    });

    it('never locks, never talks tiers or nodes, never shows a Ʀ', () => {
        const all = [...strings(LOCAL_COMMUNITY_SHEET), ...strings(LOCAL_COMMUNITY_STRIP), ...strings(LOCAL_COMMUNITY_LINES)];
        for (const [path, v] of all) {
            expect(v, path).not.toMatch(/🔒|lock|unlock|tier|upgrade|premium|\bnode\b|Ʀ/i);
        }
        for (const line of [LOCAL_COMMUNITY_LINES.price, LOCAL_COMMUNITY_LINES.poll, LOCAL_COMMUNITY_LINES.invites, LOCAL_COMMUNITY_LINES.profile]) {
            expect(line.startsWith('🏘️ ')).toBe(true);
        }
    });

    it('the words are frozen', () => {
        for (const o of [LOCAL_COMMUNITY_SHEET, LOCAL_COMMUNITY_SHEET.features, LOCAL_COMMUNITY_SHEET.guide, LOCAL_COMMUNITY_STRIP, LOCAL_COMMUNITY_STRIP.lead, LOCAL_COMMUNITY_LINES, SHOWCASE_FEATURES]) {
            expect(Object.isFrozen(o)).toBe(true);
        }
    });
});
