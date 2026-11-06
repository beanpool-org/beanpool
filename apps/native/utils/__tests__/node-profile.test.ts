/**
 * What kind of node a community is (utils/node-profile.ts): the profile and features it reports, kept per node,
 * the global community's door check, and the tabs a node with Beans off hides.
 *
 * Nothing here contacts a node: every answer comes from a fetch stub, and anything else it is asked fails.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { askedPushOn } from '@beanpool/core';

const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => store.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { store.delete(key); }),
    },
}));

import {
    GLOBAL_NODE_URL,
    GLOBAL_DOOR_MESSAGES,
    readNodeProfile,
    fetchNodeProfile,
    getCachedNodeProfile,
    checkGlobalDoor,
    hiddenTabsFor,
    beansOn,
    shareOutsideOn,
    pollsInformal,
    INFORMAL_POLL_NOTE,
    effectiveFeatures,
    readReaderFeatures,
} from '../node-profile';
import { communityShapeLines } from '@beanpool/core';

const GLOBAL_INFO = {
    memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0,
    currency: { type: 'image', value: 'bean' },
    profile: 'global',
    features: {
        beans: false, escrow: false, enterprises: false, openJoin: true, knocks: false,
        distanceSearch: true, probation: true, autoHideReports: true, autoMute: true,
    },
};
const LOCAL_INFO = { ...GLOBAL_INFO, profile: 'local', features: { ...GLOBAL_INFO.features, beans: true, openJoin: false } };

function answering(byUrl: Record<string, { status: number; body?: unknown } | 'offline'>) {
    return vi.fn(async (input: any) => {
        const url = String(input);
        const a = byUrl[url];
        if (!a || a === 'offline') throw new TypeError(`Network request failed: ${url}`);
        return {
            ok: a.status >= 200 && a.status < 300,
            status: a.status,
            json: async () => a.body,
        } as unknown as Response;
    });
}

beforeEach(() => {
    store.clear();
});

describe('the global community', () => {
    it('is global.beanpool.org', () => {
        expect(GLOBAL_NODE_URL).toBe('https://global.beanpool.org');
    });
});

describe('readNodeProfile', () => {
    it('reads the profile and features a node reports', () => {
        const p = readNodeProfile(GLOBAL_INFO, new Date('2026-09-26T00:00:00Z'))!;
        expect(p.profile).toBe('global');
        expect(p.features).toMatchObject({ beans: false, openJoin: true, distanceSearch: true });
        expect(p.checkedAt).toBe('2026-09-26T00:00:00.000Z');
    });

    it('reads a node that says nothing about its profile as local, with no features (every node before G0)', () => {
        const p = readNodeProfile({ memberCount: 12, currency: { type: 'image', value: 'bean' } })!;
        expect(p.profile).toBe('local');
        expect(p.features).toEqual({});
    });

    it('makes only the exact word "global" global', () => {
        for (const profile of ['GLOBAL', 'Global ', 'glob', 'open', 1, true, null]) {
            expect(readNodeProfile({ profile })!.profile).toBe('local');
        }
    });

    it('keeps only true and false from the features', () => {
        const p = readNodeProfile({ profile: 'global', features: { beans: 'false', openJoin: 1, knocks: false, bogus: true } })!;
        expect(p.features).toEqual({ knocks: false });
    });

    it('keeps membersOnDemand, which the node reports from #1847 on (DESIGN-global-members-by-area §2.1)', () => {
        expect(readNodeProfile({ profile: 'global', features: { membersOnDemand: true } })!.features).toEqual({ membersOnDemand: true });
        expect(readNodeProfile({ profile: 'local', features: { membersOnDemand: 'yes' } })!.features).toEqual({});
        expect(readNodeProfile({ profile: 'local', features: {} })!.features.membersOnDemand).toBeUndefined();
    });

    it('keeps pins, which a community reports from pinning S1 on (DESIGN-pinning-fable.md §2)', () => {
        expect(readNodeProfile({ profile: 'local', features: { pins: true } })!.features).toEqual({ pins: true });
        expect(readNodeProfile({ profile: 'local', features: { pins: false } })!.features).toEqual({ pins: false });
        expect(readNodeProfile({ profile: 'local', features: { pins: 'yes' } })!.features).toEqual({});
    });

    it('keeps shareOutside, which a local community reports while members may share a post outside (front doors S6)', () => {
        const local = readNodeProfile({ profile: 'local', features: { shareOutside: true } })!;
        expect(local.features).toEqual({ shareOutside: true });
        expect(shareOutsideOn(local.features)).toBe(true);
        expect(shareOutsideOn(readNodeProfile({ profile: 'local', features: {} })!.features)).toBe(false);
        expect(shareOutsideOn(readNodeProfile({ profile: 'local', features: { shareOutside: 'yes' } })!.features)).toBe(false);
        expect(shareOutsideOn(null)).toBe(false);
    });

    it('keeps askedPush, which a local community with Beans on reports: it tells members when a neighbour asks (cold start N3)', () => {
        const local = readNodeProfile({ profile: 'local', features: { askedPush: true } })!;
        expect(local.features).toEqual({ askedPush: true });
        expect(askedPushOn(local.features)).toBe(true);
        expect(askedPushOn(readNodeProfile({ profile: 'local', features: {} })!.features)).toBe(false);
        expect(askedPushOn(readNodeProfile({ profile: 'local', features: { askedPush: 'yes' } })!.features)).toBe(false);
    });

    it('is null for an answer that is not an info answer', () => {
        expect(readNodeProfile(null)).toBeNull();
        expect(readNodeProfile('global')).toBeNull();
        expect(readNodeProfile([GLOBAL_INFO])).toBeNull();
    });

    // HTTPS S3 (DESIGN-https-anywhere-fable.md §3, D4): the hourly read of the info keeps where the community lives, so the
    // phone can offer to follow it (utils/address-follow.ts). Nothing read it before.
    it('keeps the community\'s own addresses as bare hosts, and primaryAddress only when it is one of them', () => {
        const p = readNodeProfile({ addresses: ['203.0.113.5', 'Beans.Example.ORG', 'beans.example.org', 'beans.example.org:8443'], primaryAddress: 'BEANS.example.org' })!;
        expect(p.addresses).toEqual(['203.0.113.5', 'beans.example.org', 'beans.example.org:8443']);
        expect(p.primaryAddress).toBe('beans.example.org');
        expect(readNodeProfile({ addresses: ['203.0.113.5'], primaryAddress: 'elsewhere.example.org' })!).not.toHaveProperty('primaryAddress');
        expect(readNodeProfile({ addresses: [], primaryAddress: null })!).toMatchObject({ addresses: [] });
    });

    it('drops anything in addresses that is not a bare host: a scheme, a path, a login, a space, a non-string', () => {
        const p = readNodeProfile({
            addresses: ['https://beans.example.org', 'beans.example.org/x', 'user@beans.example.org', 'beans example.org', 'a\\b.org', '-bad.org', 7, null, 'ok.example.org'],
            primaryAddress: 'https://beans.example.org',
        })!;
        expect(p.addresses).toEqual(['ok.example.org']);
        expect(p).not.toHaveProperty('primaryAddress');
    });

    it('says nothing of addresses for a node that says nothing of them (one older than them)', () => {
        const p = readNodeProfile({ profile: 'local', primaryAddress: 'beans.example.org' })!;
        expect(p).not.toHaveProperty('addresses');
        expect(p).not.toHaveProperty('primaryAddress');
    });

    it('a copy read back from the phone keeps them', async () => {
        const p = readNodeProfile({ addresses: ['203.0.113.5', 'beans.example.org'], primaryAddress: 'beans.example.org' }, new Date('2026-10-18T00:00:00Z'))!;
        expect(readNodeProfile(JSON.parse(JSON.stringify(p)), new Date(p.checkedAt))).toEqual(p);
    });
});

describe('the floor and the rule\'s two lines, from a member\'s read to "How this community works" (review of #2746)', () => {
    // What GET /api/community/me says to a member of a known community (apps/server config/features-for.ts).
    const WIRE = { beans: true, escrow: true, door: 'members', knownFloor: 1000, debtLinePct: 50, quietDays: 60 };
    const RULE = /^The admins can see a confirmed member's balance/;

    it('the reader\'s answer keeps the three numbers', () => {
        expect(readNodeProfile({ features: WIRE })?.features).toMatchObject({ knownFloor: 1000, debtLinePct: 50, quietDays: 60 });
    });

    it('keeps only numbers, and says nothing of what a node left out', () => {
        const features = readNodeProfile({ features: { ...WIRE, debtLinePct: '50', quietDays: null } })?.features;
        expect(features).not.toHaveProperty('debtLinePct');
        expect(features).not.toHaveProperty('quietDays');
        expect(features?.knownFloor).toBe(1000);
        expect(readNodeProfile({ features: { beans: true } })?.features).toEqual({ beans: true });
    });

    it('the reader\'s set carries them over the node\'s, which never has them', () => {
        const reader = readNodeProfile({ features: WIRE })!.features;
        const node = readNodeProfile({ features: { beans: true, escrow: true } })!.features;
        expect(effectiveFeatures(node, reader)).toMatchObject({ knownFloor: 1000, debtLinePct: 50, quietDays: 60 });
    });

    it('through both, the page draws the floor and then the rule, the same lines as the node\'s own answer draws', () => {
        const node = readNodeProfile({ features: { beans: true, escrow: true } })!.features;
        const lines = communityShapeLines(effectiveFeatures(node, readNodeProfile({ features: WIRE })!.features));
        const floor = lines.findIndex(l => l.includes('(the known floor)'));
        expect(floor).toBeGreaterThanOrEqual(0);
        expect(lines[floor + 1]).toMatch(RULE);
        expect(lines).toEqual(communityShapeLines(WIRE as Parameters<typeof communityShapeLines>[0]));
    });

    it('a node older than the rule says the floor and no lines: the floor alone, as ever', () => {
        const { debtLinePct: _p, quietDays: _q, ...older } = WIRE;
        const lines = communityShapeLines(effectiveFeatures({ beans: true }, readNodeProfile({ features: older })!.features));
        expect(lines.some(l => l.includes('(the known floor)'))).toBe(true);
        expect(lines.filter(l => RULE.test(l))).toEqual([]);
    });
});

describe('who decides a removal, from a member\'s read to "How this community works" (removal jury J3)', () => {
    // What GET /api/community/me says to a member (apps/server config/features-for.ts): the node's features, and the rule
    // beside them, never in them.
    const WIRE = { features: { beans: true, decisions: true, door: 'members' }, removalDecider: 'automatic' };

    it('the reader\'s answer keeps one of the three rules, from beside its features, and nothing else', () => {
        expect(readReaderFeatures(WIRE)?.removalDecider).toBe('automatic');
        expect(readReaderFeatures(WIRE)).toMatchObject({ beans: true, decisions: true, door: 'members' });
        for (const rule of ['everyone', 'jury'] as const) {
            expect(readReaderFeatures({ ...WIRE, removalDecider: rule })?.removalDecider).toBe(rule);
        }
        expect(readReaderFeatures({ ...WIRE, removalDecider: 'sometimes' })).not.toHaveProperty('removalDecider');
        expect(readReaderFeatures({ ...WIRE, removalDecider: true })).not.toHaveProperty('removalDecider');
        // A read with no rule (a node from before J3), and one with no features at all.
        expect(readReaderFeatures({ features: WIRE.features })).not.toHaveProperty('removalDecider');
        expect(readReaderFeatures({ removalDecider: 'jury' })).toBeNull();
        expect(readReaderFeatures(null)).toBeNull();
    });

    it('the reader\'s set carries it over the node\'s, and the page says it under Decisions', () => {
        const node = readNodeProfile({ features: { beans: true, decisions: true, door: 'members' } })!.features;
        const lines = communityShapeLines(effectiveFeatures(node, readReaderFeatures(WIRE)));
        const decisions = lines.findIndex(l => l.startsWith('**Decisions:**'));
        expect(lines[decisions + 1]).toBe('**Removals:** decided by everyone who can vote until 100 members could serve on a jury, then by a jury drawn at random');
        // A read with no rule (a visitor's, a node from before J3) draws no line.
        expect(communityShapeLines(effectiveFeatures(node, null)).join('\n')).not.toMatch(/Removals/);
    });
});

describe('fetchNodeProfile and the per-node cache', () => {
    it('asks /api/community/info and keeps the answer for that node', async () => {
        const fetchImpl = answering({ 'https://mullum.beanpool.org/api/community/info': { status: 200, body: LOCAL_INFO } });
        const fetched = await fetchNodeProfile('https://mullum.beanpool.org', fetchImpl as any);
        expect(fetched?.profile).toBe('local');
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        const cached = await getCachedNodeProfile('https://mullum.beanpool.org');
        expect(cached?.profile).toBe('local');
        expect(cached?.features.beans).toBe(true);
    });

    it('keeps one entry per node, whatever the spelling of its address', async () => {
        const fetchImpl = answering({ 'https://global.beanpool.org/api/community/info': { status: 200, body: GLOBAL_INFO } });
        await fetchNodeProfile('https://global.beanpool.org/', fetchImpl as any);
        expect((await getCachedNodeProfile('https://GLOBAL.beanpool.org'))?.profile).toBe('global');
        expect((await getCachedNodeProfile('https://global.beanpool.org'))?.features.beans).toBe(false);
    });

    it('keeps each node apart', async () => {
        const fetchImpl = answering({
            'https://global.beanpool.org/api/community/info': { status: 200, body: GLOBAL_INFO },
            'https://mullum.beanpool.org/api/community/info': { status: 200, body: LOCAL_INFO },
        });
        await fetchNodeProfile('https://global.beanpool.org', fetchImpl as any);
        await fetchNodeProfile('https://mullum.beanpool.org', fetchImpl as any);
        expect((await getCachedNodeProfile('https://global.beanpool.org'))?.profile).toBe('global');
        expect((await getCachedNodeProfile('https://mullum.beanpool.org'))?.profile).toBe('local');
    });

    it('leaves what it knew alone when the node cannot be asked, and says it could not', async () => {
        const good = answering({ 'https://global.beanpool.org/api/community/info': { status: 200, body: GLOBAL_INFO } });
        await fetchNodeProfile('https://global.beanpool.org', good as any);

        const offline = answering({ 'https://global.beanpool.org/api/community/info': 'offline' });
        expect(await fetchNodeProfile('https://global.beanpool.org', offline as any)).toBeNull();
        const failing = answering({ 'https://global.beanpool.org/api/community/info': { status: 502, body: {} } });
        expect(await fetchNodeProfile('https://global.beanpool.org', failing as any)).toBeNull();

        expect((await getCachedNodeProfile('https://global.beanpool.org'))?.profile).toBe('global');
    });

    it('knows nothing about a node it never asked', async () => {
        expect(await getCachedNodeProfile('https://castlemaine.beanpool.org')).toBeNull();
        expect(await getCachedNodeProfile(null)).toBeNull();
    });
});

describe('checkGlobalDoor: refused unless the node says it is the global community, with its door open', () => {
    const INFO = `${GLOBAL_NODE_URL}/api/community/info`;

    it('lets a member through to the door of the global community', async () => {
        const check = await checkGlobalDoor(GLOBAL_NODE_URL, answering({ [INFO]: { status: 200, body: GLOBAL_INFO } }) as any);
        expect(check.ok).toBe(true);
    });

    it('refuses a node that is not global, so a stale build can never open-join a local community', async () => {
        const check = await checkGlobalDoor(GLOBAL_NODE_URL, answering({ [INFO]: { status: 200, body: LOCAL_INFO } }) as any);
        expect(check).toEqual({ ok: false, reason: 'not_global' });
    });

    it('refuses a node that says nothing about its profile', async () => {
        const check = await checkGlobalDoor(GLOBAL_NODE_URL, answering({ [INFO]: { status: 200, body: { memberCount: 1 } } }) as any);
        expect(check).toEqual({ ok: false, reason: 'not_global' });
    });

    it('says the door is shut when the global community is not taking members', async () => {
        const shut = { ...GLOBAL_INFO, features: { ...GLOBAL_INFO.features, openJoin: false } };
        expect(await checkGlobalDoor(GLOBAL_NODE_URL, answering({ [INFO]: { status: 200, body: shut } }) as any))
            .toEqual({ ok: false, reason: 'door_closed' });
        const unsaid = { ...GLOBAL_INFO, features: { beans: false } };
        expect(await checkGlobalDoor(GLOBAL_NODE_URL, answering({ [INFO]: { status: 200, body: unsaid } }) as any))
            .toEqual({ ok: false, reason: 'door_closed' });
    });

    it('says it cannot reach the global community, even when this phone once heard it was open', async () => {
        await checkGlobalDoor(GLOBAL_NODE_URL, answering({ [INFO]: { status: 200, body: GLOBAL_INFO } }) as any);
        expect(await checkGlobalDoor(GLOBAL_NODE_URL, answering({ [INFO]: 'offline' }) as any))
            .toEqual({ ok: false, reason: 'unreachable' });
        expect(await checkGlobalDoor(GLOBAL_NODE_URL, answering({ [INFO]: { status: 503, body: {} } }) as any))
            .toEqual({ ok: false, reason: 'unreachable' });
    });

    it('always leaves invites as the way in when it refuses', () => {
        expect(GLOBAL_DOOR_MESSAGES.unreachable).toMatch(/try again, or join with an invite/i);
        expect(GLOBAL_DOOR_MESSAGES.not_global).toMatch(/invite/);
        expect(GLOBAL_DOOR_MESSAGES.door_closed).toMatch(/invite/);
    });
});

describe('the tabs a node hides', () => {
    it('Beans off + Decisions on: Commons stays for Decide, Ledger is hidden', () => {
        expect(hiddenTabsFor({ beans: false, decisions: true })).toEqual(['ledger']);
        expect(hiddenTabsFor({ beans: false })).toEqual(['ledger']);
        expect(beansOn({ beans: false })).toBe(false);
    });

    it('Beans off + Decisions off: Commons and Ledger are both hidden', () => {
        expect(hiddenTabsFor({ beans: false, decisions: false })).toEqual(['projects', 'ledger']);
    });

    it('showcase on: neither is hidden, even with Beans off and Decisions off', () => {
        expect(hiddenTabsFor({ beans: false, decisions: false, showcase: true })).toEqual([]);
        expect(hiddenTabsFor({ beans: false, decisions: true, showcase: true })).toEqual([]);
    });

    it('hides nothing where Beans are on, or where the node does not say', () => {
        expect(hiddenTabsFor({ beans: true })).toEqual([]);
        expect(hiddenTabsFor({ beans: true, decisions: false })).toEqual([]);
        expect(hiddenTabsFor({})).toEqual([]);
        expect(hiddenTabsFor(null)).toEqual([]);
        expect(hiddenTabsFor(undefined)).toEqual([]);
        expect(beansOn(undefined)).toBe(true);
    });

    const layout = () => fs.readFileSync(path.resolve(__dirname, '../../app/(tabs)/_layout.tsx'), 'utf-8');

    it('the tab bar takes Commons and Ledger off the strip from the node\'s features', () => {
        const src = layout();
        expect(src).toMatch(/hiddenTabsFor\(/);
        expect(src).toMatch(/name="projects"\s*options=\{\{\s*\.\.\.\(hiddenTabs\.includes\('projects'\) \? \{ href: null \} : \{\}\)/);
        expect(src).toMatch(/name="ledger"\s*options=\{\{\s*\.\.\.\(hiddenTabs\.includes\('ledger'\) \? \{ href: null \} : \{\}\)/);
    });

    it('leaves every other tab as it was', () => {
        const src = layout();
        for (const tab of ['index', 'map', 'chats', 'pulse']) {
            const at = src.indexOf(`name="${tab}"`);
            expect(at).toBeGreaterThan(-1);
            expect(src.slice(at, at + 200)).not.toMatch(/hiddenTabs/);
        }
    });
});

// On the worldwide community anyone may join with a sign-in, so a poll's count can be tipped by one person with several
// accounts (FABLE-sec-global-abuse LOW-7): there each poll says it decides nothing.
describe('polls on the worldwide community are informal', () => {
    it('are labelled there, and only there', () => {
        expect(pollsInformal(readNodeProfile(GLOBAL_INFO))).toBe(true);
        expect(pollsInformal(readNodeProfile(LOCAL_INFO))).toBe(false);
        expect(pollsInformal(readNodeProfile({ memberCount: 1 }))).toBe(false);
        expect(pollsInformal(null)).toBe(false);
        expect(pollsInformal(undefined)).toBe(false);
        expect(INFORMAL_POLL_NOTE).toBe('An informal poll; it decides nothing');
    });

    const source = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf-8');

    it('the Market tab tells each poll card which community it is on', () => {
        const src = source('../../app/(tabs)/market.tsx');
        const card = src.slice(src.indexOf('<PollCard'), src.indexOf('/>', src.indexOf('<PollCard')));
        expect(card).toMatch(/informal=\{pollsInformal\(nodeProfile\)\}/);
    });

    it('the card shows the note when it is told to', () => {
        const src = source('../../components/PollCard.tsx');
        // In the member's language since words S3b: the same note, through t().
        expect(src).toMatch(/const LINES = \{ informal: INFORMAL_POLL_NOTE \};/);
        expect(src).toMatch(/\{informal && \(\s*<Text style=\{styles\.informalNote\} testID="poll-informal-note">\s*\{t\('💬 \{note\}', \{ note: t\(LINES\.informal\) \}\)\}/);
    });
});
