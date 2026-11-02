// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Module from 'node:module';
import { DatabaseSync } from 'node:sqlite';

// The quiz on the real screen, against the real data layer. working-style-across-communities.test.ts runs performSync but
// has no screen, and public-profile-quiz-community-name.test.ts has the screen and a stubbed db, so neither can see what the
// screen's own publish leaves behind for the next sync. Here app/public-profile.tsx is rendered over the real db.ts, copies
// and pending store (the harness of the first), and the node is a stub per address that holds what it accepts.

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const A = 'https://a.beanpool.org';
const B = 'https://b.example.net';
const ME = 'ab'.repeat(32);

const files = new Map<string, DatabaseSync>();
const params = (p: unknown) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as any[];
function adapterFor(name: string) {
    let sql = files.get(name);
    if (!sql) {
        sql = new DatabaseSync(':memory:');
        files.set(name, sql);
    }
    const file = sql;
    return {
        runAsync: async (q: string, p?: unknown) => {
            const r = file.prepare(q).run(...params(p));
            return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
        },
        execAsync: async (q: string) => { file.exec(q); },
        getAllAsync: async (q: string, p?: unknown) => file.prepare(q).all(...params(p)),
        getFirstAsync: async (q: string, p?: unknown) => file.prepare(q).get(...params(p)) ?? null,
        closeAsync: async () => {},
        withTransactionAsync: async (cb: () => Promise<void>) => { await cb(); },
    };
}

const store = vi.hoisted(() => new Map<string, string>());
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn(async (name: string) => adapterFor(name)) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.set(k, String(v)); }),
        removeItem: vi.fn(async (k: string) => { store.delete(k); }),
        getAllKeys: vi.fn(async () => [...store.keys()]),
        multiRemove: vi.fn(async (ks: string[]) => { for (const k of ks) store.delete(k); }),
    },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid', getRandomBytes: () => new Uint8Array(16) }));
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: '/tmp/cache/',
    getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
    makeDirectoryAsync: vi.fn().mockResolvedValue(undefined),
    writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
const me = vi.hoisted(() => ({ identity: { publicKey: 'ab'.repeat(32), privateKey: 'aa', callsign: 'Marty' } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => me.identity) }));
vi.mock('../nodes', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../nodes')>()),
    getDatabaseFilenameForNode: vi.fn((url: string | null) => (url ? `beanpool_${new URL(url).hostname}.db` : 'beanpool_none.db')),
}));
vi.mock('../crypto', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../crypto')>()),
    buildSignedHeaders: vi.fn(async () => ({ 'x-test-signature': 'signed' })),
}));

// The screen, as the quiz suite renders it: react-native as plain elements, and what isn't under test left out.
vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, disabled, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (testID) attrs['data-testid'] = testID;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), SafeAreaView: el('div'), TextInput: el('input'),
        ActivityIndicator: () => createElement('span', null, '…'),
        KeyboardAvoidingView: el('div'), Alert: { alert: vi.fn() },
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', null, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
        DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
    };
});
const nav = vi.hoisted(() => ({ params: {} as Record<string, string>, router: { push: vi.fn(), replace: vi.fn(), back: vi.fn() } }));
vi.mock('expo-router', () => ({
    router: nav.router,
    useLocalSearchParams: () => nav.params,
    ErrorBoundary: () => null,
    useFocusEffect: (cb: () => void) => { cb(); },
}));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: me.identity, setIdentity: vi.fn() }) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { colors: lightColors, theme: 'light' };
    return { useTheme: () => ctx, useStyles: (f: (t: unknown) => unknown) => f(ctx) };
});
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 34, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../blocklist', () => ({
    BLOCKLIST_UPDATED_EVENT: 'beanpool_blocklist_updated',
    blockUser: vi.fn(async () => true),
    unblockUser: vi.fn(async () => true),
    isUserBlocked: vi.fn(async () => false),
}));
vi.mock('../channels', () => ({ fetchPublicChannels: vi.fn(async () => []) }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => ({ profile: 'local', checkedAt: new Date().toISOString(), features: { beans: true } }) }));
vi.mock('../use-reader-features', () => ({ useShowcaseMode: () => 'off' }));
// performSync reads the rest of this one: stubbed whole, it stops at the first thing missing and these tests prove nothing.
vi.mock('../reads-own', async (importOriginal) => ({ ...(await importOriginal<typeof import('../reads-own')>()), readsOwn: vi.fn(async () => true) }));
vi.mock('../members-lookup', () => ({ cardNeedsFetch: () => false, fetchCardByKey: vi.fn(async () => null) }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => null }));
vi.mock('../../components/ReviewModal', () => ({ ReviewModal: () => null }));
vi.mock('../../components/ChannelChips', () => ({ ChannelChips: () => null }));
vi.mock('../../components/showcase/LocalCommunityMark', () => ({ LocalCommunityMark: () => null }));
const quiz = vi.hoisted(() => ({ outcome: null as unknown }));
vi.mock('../../components/ArchetypeQuizModal', () => ({
    // Always there: whichever button opens the real one, a first quiz and a retake end in onComplete.
    ArchetypeQuizModal: ({ onComplete }: { onComplete: (res: unknown) => void }) => createElement('button', {
        'data-testid': 'complete-quiz',
        onClick: () => onComplete(quiz.outcome),
    }, 'Complete Quiz'),
}));

const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'react-native') return { DeviceEventEmitter: { emit: () => {} } };
    return realLoad.call(this, request, ...rest);
};
afterAll(() => { (Module as any)._load = realLoad; });

import { ARCHETYPES, publicArchetype, type QuizResult } from '@beanpool/core';
import PublicProfileScreen from '../../app/public-profile';
import { closeDB, getDb, getMemberProfile, pushProfileToServer, updateMemberProfile } from '../db';
import { addSavedNode, clearGuestNode, markGuestNode } from '../nodes';
import { waitingArchetype } from '../pending-profile-sync';
import { archetypeToSend } from '../working-style';
import { performSync, resetSyncFingerprints } from '../../services/pillar-sync';

type NodeState = { mode: 'ok' | 'offline' | 'busy'; member: boolean; held: { callsign: string; bio: string | null; archetype: string | null }; updates: any[]; waitingAtPublish: Array<string | null> };
const nodes = new Map<string, NodeState>();
function nodeAt(origin: string) {
    let n = nodes.get(origin);
    if (!n) {
        n = { mode: 'ok', member: true, held: { callsign: 'Marty', bio: null, archetype: null }, updates: [], waitingAtPublish: [] };
        nodes.set(origin, n);
    }
    return n;
}

function answer(status: number, body: string) {
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => body, json: async () => JSON.parse(body) };
}
const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const { origin, pathname } = new URL(url);
    const node = nodeAt(origin);
    if (node.mode === 'offline') throw new TypeError('Network request failed');
    if (pathname.startsWith('/api/community/membership/')) return answer(200, JSON.stringify({ isMember: node.member }));
    if (pathname === '/api/profile/update' && init?.method === 'POST') {
        const body = JSON.parse(init.body ?? '{}');
        node.updates.push(body);
        // What is on the phone as the publish arrives: an app that dies now leaves only this.
        node.waitingAtPublish.push(await waitingArchetype(origin, ME));
        if (node.mode === 'busy') return answer(503, JSON.stringify({ error: 'busy' }));
        if (!node.member) return answer(404, JSON.stringify({ error: 'Member not found' }));
        if (body.bio !== undefined) node.held.bio = body.bio;
        if (body.archetype !== undefined) node.held.archetype = body.archetype;
        return answer(200, JSON.stringify({ success: true, profile: { ...node.held } }));
    }
    if (pathname === `/api/profile/${ME}`) return answer(200, JSON.stringify({ publicKey: ME, ...node.held }));
    if (pathname === '/api/marketplace/posts') return answer(200, '[]');
    if (pathname === '/api/members') {
        return answer(200, JSON.stringify(node.member ? [{ publicKey: ME, callsign: node.held.callsign, archetype: node.held.archetype }] : []));
    }
    return answer(404, '');
});

const result = (primary: QuizResult['primary'], mode: QuizResult['mode'] = 'quick'): QuizResult => ({
    primary, secondary: 'weaver', mode, scores: { [primary]: 3 } as QuizResult['scores'], takenOn: '2026-11-03',
});
/** Quick then deep on one day, the ordinary same-day retake. */
const FIRST = result('spark', 'quick');
const RETAKE = result('guardian', 'deep');

async function openCommunity(url: string) {
    store.set('beanpool_anchor_url', url);
    resetSyncFingerprints();
    await getDb();
}

async function memberOfBoth() {
    await addSavedNode(A);
    await addSavedNode(B);
    await openCommunity(B);
    await updateMemberProfile(ME, { callsign: 'Marty', bio: 'Bakes on Fridays' });
    await openCommunity(A);
    await updateMemberProfile(ME, { callsign: 'Marty', bio: 'Bakes on Fridays' });
}

/** A sync that ran to its end: one that stopped early sends nothing, and would pass every check below. */
async function syncCompletes() {
    expect((await performSync()).success).toBe(true);
}

let host: HTMLElement | null = null;
let root: Root | null = null;

async function settle(rounds = 8) {
    for (let i = 0; i < rounds; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}
async function showMyProfile() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(createElement(PublicProfileScreen as any) as unknown as Parameters<Root['render']>[0]); });
    await settle();
}
function leaveScreen() {
    if (root) act(() => root!.unmount());
    host?.remove();
    host = null;
    root = null;
}
/** The quiz taken on the member's own card, in the community open now. */
async function takeQuiz(outcome: QuizResult) {
    quiz.outcome = outcome;
    await showMyProfile();
    await act(async () => { (document.querySelector('[data-testid="complete-quiz"]') as HTMLElement).click(); });
    await settle();
}

beforeEach(async () => {
    await closeDB();
    files.clear();
    store.clear();
    nodes.clear();
    fetchMock.mockClear();
    (globalThis as any).fetch = fetchMock;
    nav.params = { publicKey: ME };
    store.set('beanpool_node_profiles', JSON.stringify(Object.fromEntries([A, B].map(u => [u, { profile: 'local', features: {}, checkedAt: new Date().toISOString() }]))));
});
afterEach(() => { leaveScreen(); });

describe('a retake that landed is not replaced by the older result that waited there', () => {
    /** Steps 1 to 3: FIRST on B waits for A, A is out of reach at its sync, and the retake lands on A the same day. */
    async function retakeLandedOverWhatWaited() {
        await memberOfBoth();
        await openCommunity(B);
        await takeQuiz(FIRST);
        leaveScreen();
        expect(await waitingArchetype(A, ME)).toBe(publicArchetype(FIRST));

        await openCommunity(A);
        nodeAt(A).mode = 'offline';
        await performSync();
        expect(await waitingArchetype(A, ME)).toBe(publicArchetype(FIRST));

        nodeAt(A).mode = 'ok';
        await takeQuiz(RETAKE);
        leaveScreen();
        expect(nodeAt(A).held.archetype).toBe(publicArchetype(RETAKE));
    }

    it('at A\'s next sync: A keeps the retake, and nothing waits', async () => {
        await retakeLandedOverWhatWaited();
        await syncCompletes();
        expect(nodeAt(A).held.archetype).toBe(publicArchetype(RETAKE));
        expect(await waitingArchetype(A, ME)).toBeNull();
        expect((await getMemberProfile(ME))?.archetype).not.toBe(publicArchetype(FIRST));
    });

    it('through a catch-up publish: the same', async () => {
        await retakeLandedOverWhatWaited();
        await pushProfileToServer();
        expect(nodeAt(A).held.archetype).toBe(publicArchetype(RETAKE));
        expect(await waitingArchetype(A, ME)).toBeNull();
    });

    it('a quiz that failed on A, then the retake there, the same', async () => {
        await memberOfBoth();
        nodeAt(A).mode = 'busy';
        await takeQuiz(FIRST);
        leaveScreen();
        expect(await waitingArchetype(A, ME)).toBe(publicArchetype(FIRST));

        nodeAt(A).mode = 'ok';
        await takeQuiz(RETAKE);
        leaveScreen();
        await syncCompletes();
        expect(nodeAt(A).held.archetype).toBe(publicArchetype(RETAKE));
    });

    it('a retake that didn\'t land either: the retake is what waits, and it goes at the next sync', async () => {
        await memberOfBoth();
        await openCommunity(B);
        await takeQuiz(FIRST);
        leaveScreen();
        await openCommunity(A);
        nodeAt(A).mode = 'busy';
        await takeQuiz(RETAKE);
        leaveScreen();
        expect(await waitingArchetype(A, ME)).toBe(publicArchetype(RETAKE));

        nodeAt(A).mode = 'ok';
        await syncCompletes();
        expect(nodeAt(A).held.archetype).toBe(publicArchetype(RETAKE));
        expect(await waitingArchetype(A, ME)).toBeNull();
    });

    it('it waits before the publish goes: an app that dies with it out leaves the retake, not the older result', async () => {
        await memberOfBoth();
        await openCommunity(B);
        await takeQuiz(FIRST);
        leaveScreen();
        await openCommunity(A);
        await takeQuiz(RETAKE);
        expect(nodeAt(A).waitingAtPublish).toEqual([publicArchetype(RETAKE)]);
    });
});

describe('a quiz taken on a guest visit reaches the community when the member joins', () => {
    const visit = async () => {
        await addSavedNode(B);
        await markGuestNode(B);
        nodeAt(B).member = false;
        await openCommunity(B);
    };
    /** The join, as redeemInvite leaves things: a member now, and the guest mark gone. */
    const join = async () => {
        nodeAt(B).member = true;
        await clearGuestNode(B);
    };

    it('nothing goes during the visit, and the join sends it', async () => {
        await visit();
        await takeQuiz(FIRST);
        leaveScreen();
        expect(nodeAt(B).updates).toEqual([]);
        expect((await getMemberProfile(ME))?.archetype ?? null).toBeNull();

        await join();
        await pushProfileToServer();
        await syncCompletes();
        expect(nodeAt(B).held.archetype).toBe(publicArchetype(FIRST));
    });

    it('a join with no catch-up publish of its own (the People tab, a door): the next Save carries it', async () => {
        await visit();
        await takeQuiz(FIRST);
        leaveScreen();
        await join();
        await syncCompletes();
        expect(nodeAt(B).updates).toEqual([]);
        expect(await archetypeToSend(B, me.identity, (await getMemberProfile(ME))?.archetype)).toBe(publicArchetype(FIRST));
    });

    it('a sync before the join sends nothing either', async () => {
        await visit();
        await takeQuiz(FIRST);
        leaveScreen();
        await syncCompletes();
        expect(nodeAt(B).updates).toEqual([]);
    });

    it('the member still sees their own result on the card, as they take it and when they come back to it', async () => {
        await visit();
        await takeQuiz(FIRST);
        expect(document.body.textContent).toContain(ARCHETYPES.spark.name);

        leaveScreen();
        await showMyProfile();
        expect(document.body.textContent).toContain(ARCHETYPES.spark.name);
    });
});
