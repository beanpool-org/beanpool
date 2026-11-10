/**
 * The clean-slate cutover on the phone (DESIGN-clean-slate-cutover-fable.md §1, slice P): the app talks to servers from
 * 1.4.0 on (utils/node-version-gate.ts MIN_NODE_VERSION, baked in). A community whose health names an older version gets
 * one card (the full-screen block, utils/force-update.ts `node-too-old`) and no other request; and a 426 `app_too_old`
 * from the community is the full-screen "Update required" at once.
 *
 * Nothing here contacts a node: every answer is the test's.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (n: number) => new Uint8Array(randomBytes(n)) };
});
const mem = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => mem.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { mem.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.delete(k); }),
    },
}));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => undefined) }));
vi.mock('expo-local-authentication', () => ({
    SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
    getEnrolledLevelAsync: vi.fn(async () => 3),
    authenticateAsync: vi.fn(async () => ({ success: true })),
}));
const who = vi.hoisted(() => ({ identity: null as null | { publicKey: string; privateKey: string; callsign: string } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => who.identity) }));

import { ed25519 } from '@noble/curves/ed25519.js';
import {
    MIN_NODE_VERSION, NodeTooOldError, isNodeTooOldError, nodeTooOldText, nodeVersionBelowMinimum, noteHealthAnswer, resetNodeVersionGateForTests,
    tooOldVersionOf,
} from '../node-version-gate';
import { checkCommunityForUpdate, createForceUpdateGate, evaluateForceUpdate, onAppRefused, type ForceUpdateDecision, type UpdateBlockShown } from '../force-update';
import { installNodeRequestSigning } from '../node-request-signing';
import { SAVED_NODES_STORE_KEY } from '../storage-keys';

const SEED = new Uint8Array(32).fill(5);
const PUB = Buffer.from(ed25519.getPublicKey(SEED)).toString('hex');
const identity = { publicKey: PUB, privateKey: Buffer.from(SEED).toString('hex'), callsign: 'Ivy' };

const HOME = 'https://home.cutover.test';
const OTHER = 'https://other.cutover.test';

interface Call { url: string; method: string; headers: Record<string, string> }
let calls: Call[] = [];
/** Each answer by `origin + path`: a body (200) or `{ status, body }`. */
let answers: Record<string, unknown> = {};

function reply(status: number, body: unknown): Response {
    const make = (): any => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
        clone: () => make(),
    });
    return make() as Response;
}

async function stubFetch(input: string, init?: RequestInit): Promise<Response> {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', headers: { ...(init?.headers as Record<string, string> ?? {}) } });
    const u = new URL(url);
    const a = answers[`${u.origin}${u.pathname}`];
    if (a === undefined) return reply(404, { error: 'Not Found' });
    if (a && typeof a === 'object' && 'status' in a) {
        const r = a as { status: number; body?: unknown };
        return reply(r.status, r.body);
    }
    return reply(200, a);
}

// The wrapper is installed once per module (as at app start); the fetch under it is this stub for every test.
(globalThis as any).fetch = vi.fn(stubFetch);
installNodeRequestSigning({ appVersionHeader: '1.4.0 android' });

beforeEach(() => {
    calls = [];
    answers = {};
    mem.clear();
    mem.set('beanpool_anchor_url', HOME);
    mem.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: HOME }]));
    who.identity = identity;
    resetNodeVersionGateForTests();
});

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('the minimum, baked in', () => {
    it('is 1.4.0', () => {
        expect(MIN_NODE_VERSION).toBe('1.4.0');
    });

    it('a health answer below it names its version; at or above it, or no version to go on, names none', () => {
        expect(nodeVersionBelowMinimum({ version: '1.2.37' })).toBe('1.2.37');
        expect(nodeVersionBelowMinimum({ version: '1.3.9' })).toBe('1.3.9');
        expect(nodeVersionBelowMinimum({ version: 'v1.2.36' })).toBe('1.2.36');
        expect(nodeVersionBelowMinimum({ version: '1.4.0' })).toBeNull();
        expect(nodeVersionBelowMinimum({ version: '1.4.1' })).toBeNull();
        expect(nodeVersionBelowMinimum({ version: '2.0.0' })).toBeNull();
        // Every doubt is "not too old": no answer, no version, not a version, the server's unresolved 0.0.0.
        for (const doubt of [null, undefined, 'up', [], {}, { version: 'nonsense' }, { version: 1.2 }, { version: '0.0.0' }]) {
            expect(nodeVersionBelowMinimum(doubt), JSON.stringify(doubt)).toBeNull();
        }
    });

    it('the card says the server\'s version, the minimum, and who must act', () => {
        expect(nodeTooOldText('1.2.37')).toBe("This community's server runs BeanPool 1.2.37. This app needs 1.4.0 or newer. Its operator must update.");
        const e = new NodeTooOldError('1.2.37');
        expect(isNodeTooOldError(e)).toBe(true);
        expect(e.message).toBe(nodeTooOldText('1.2.37'));
        expect(isNodeTooOldError(new Error('x'))).toBe(false);
    });
});

describe('a community whose server is 1.2.37: one card, and no other request', () => {
    it('the first request of the run reads its health, and is refused before anything else leaves the phone', async () => {
        answers[`${HOME}/api/community/health`] = { version: '1.2.37' };
        answers[`${HOME}/api/community/me`] = { ok: true };
        await expect(fetch(`${HOME}/api/community/me`)).rejects.toBeInstanceOf(NodeTooOldError);
        // Its health, unsigned, and nothing else.
        expect(calls.map(c => c.url)).toEqual([`${HOME}/api/community/health`]);
        expect(calls[0].headers['X-Signature']).toBeUndefined();
        expect(tooOldVersionOf(`${HOME}/anything`)).toBe('1.2.37');

        // Every later request, any method, any path: refused here, nothing sent, not even the health again.
        await expect(fetch(`${HOME}/api/posts`)).rejects.toBeInstanceOf(NodeTooOldError);
        await expect(fetch(`${HOME}/api/ledger/transfer`, { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(NodeTooOldError);
        await expect(fetch(`${HOME}:443/api/x`)).rejects.toBeInstanceOf(NodeTooOldError);
        expect(calls).toHaveLength(1);
    });

    it('its health read itself still goes (it is how the phone hears the server was updated), and 1.4.0 lets requests through again', async () => {
        noteHealthAnswer(HOME, { version: '1.2.37' });
        answers[`${HOME}/api/community/health`] = { version: '1.4.0' };
        answers[`${HOME}/api/community/me`] = { ok: true };
        const res = await fetch(`${HOME}/api/community/health`);
        expect(res.status).toBe(200);
        await settle();
        expect(tooOldVersionOf(HOME)).toBeNull();
        expect((await fetch(`${HOME}/api/community/me`)).status).toBe(200);
        expect(calls.map(c => c.url)).toEqual([`${HOME}/api/community/health`, `${HOME}/api/community/me`]);
    });

    it('a server at 1.4.0 is asked its health once a run, then every request goes', async () => {
        answers[`${HOME}/api/community/health`] = { version: '1.4.0' };
        answers[`${HOME}/api/community/me`] = { ok: true };
        expect((await fetch(`${HOME}/api/community/me`)).status).toBe(200);
        expect((await fetch(`${HOME}/api/community/me`)).status).toBe(200);
        expect(calls.map(c => c.url)).toEqual([`${HOME}/api/community/health`, `${HOME}/api/community/me`, `${HOME}/api/community/me`]);
    });

    it('a host that is not one of the phone\'s communities is never asked its health; one a join heard below the minimum is refused', async () => {
        answers[`${OTHER}/api/x`] = { ok: true };
        expect((await fetch(`${OTHER}/api/x`)).status).toBe(200);
        expect(calls.map(c => c.url)).toEqual([`${OTHER}/api/x`]);
        // A join reads the new community's health first (utils/join-another-community.ts): heard old, nothing else goes.
        answers[`${OTHER}/api/community/health`] = { version: '1.3.4' };
        await fetch(`${OTHER}/api/community/health`);
        await settle();
        await expect(fetch(`${OTHER}/api/x`)).rejects.toBeInstanceOf(NodeTooOldError);
        expect(calls).toHaveLength(2);
    });

    it('a health that cannot be read is a doubt: the request goes, and the read is not asked again for a minute', async () => {
        answers[`${HOME}/api/community/me`] = { ok: true };
        // No health route answered: 404, not a health answer.
        expect((await fetch(`${HOME}/api/community/me`)).status).toBe(200);
        expect((await fetch(`${HOME}/api/community/me`)).status).toBe(200);
        expect(calls.map(c => c.url)).toEqual([`${HOME}/api/community/health`, `${HOME}/api/community/me`, `${HOME}/api/community/me`]);
    });

    it('the block shows the card: the community\'s health below the minimum is node-too-old, whatever its floors say', async () => {
        expect(evaluateForceUpdate('1.4.0', { version: '1.2.37' }, 'android')).toEqual({ kind: 'node-too-old', version: '1.2.37' });
        expect(evaluateForceUpdate('1.4.0', {
            version: '1.2.37', appFloors: { android: { min: '1.4.0', blocking: true } }, appVersions: { android: '1.4.0' },
        }, 'ios')).toEqual({ kind: 'node-too-old', version: '1.2.37' });
        // A current server is read for its floors as before.
        expect(evaluateForceUpdate('1.4.0', { version: '1.4.0' }, 'android')).toEqual({ kind: 'clear' });

        // At a safe moment the gate puts it up as the server's card, not the store's.
        const shown: Array<UpdateBlockShown | null> = [];
        const gate = createForceUpdateGate({
            now: () => 0,
            check: () => checkCommunityForUpdate({
                anchorUrl: async () => HOME,
                fetchJson: async () => ({ version: '1.2.37' }),
                localVersion: '1.4.0',
                platform: 'android',
            }),
            show: (b) => shown.push(b),
        });
        await gate.start('active');
        expect(shown).toEqual([{ version: '1.2.37', nodeTooOld: true }]);
        // And the check's answer holds for every request to it, whoever asked.
        expect(tooOldVersionOf(HOME)).toBe('1.2.37');
    });
});

describe('the card goes up as soon as any request hears the server too old, and comes down once it is updated', () => {
    it('serverTooOld puts the server card up at once, mid-use; serverCurrent takes only that card down', async () => {
        let release: (d: ForceUpdateDecision) => void = () => {};
        const shown: Array<UpdateBlockShown | null> = [];
        const gate = createForceUpdateGate({
            now: () => 0,
            check: () => new Promise<ForceUpdateDecision>((resolve) => { release = resolve; }),
            show: (b) => shown.push(b),
        });
        // The cold start's question is slow (past the decide window, say): the request's own first read heard it first.
        const started = gate.start('active');
        gate.serverTooOld('1.2.37');
        expect(shown).toEqual([{ version: '1.2.37', nodeTooOld: true }]);
        // The slow question answers late: asked before, so it says nothing now.
        release({ kind: 'clear' });
        await started;
        expect(shown).toEqual([{ version: '1.2.37', nodeTooOld: true }]);
        // The operator updated it: the card comes down.
        gate.serverCurrent();
        expect(shown).toEqual([{ version: '1.2.37', nodeTooOld: true }, null]);
        // serverCurrent never takes down this app's own block (its floor still holds).
        gate.refused('1.5.0');
        gate.serverCurrent();
        expect(shown[shown.length - 1]).toEqual({ version: '1.5.0' });
    });

    it('every health answer the phone reads tells the block, once per change', async () => {
        const { onNodeVersionHeard } = await import('../node-version-gate');
        let told = 0;
        const stop = onNodeVersionHeard(() => { told++; });
        try {
            noteHealthAnswer(HOME, { version: '1.2.37' });
            noteHealthAnswer(`${HOME}/api/community/health`, { version: '1.2.37' });
            expect(told).toBe(1);
            noteHealthAnswer(HOME, { version: '1.4.0' });
            expect(told).toBe(2);
            // Not a health answer: nothing changes, nobody is told.
            noteHealthAnswer(HOME, '<html>');
            expect(told).toBe(2);
            expect(tooOldVersionOf(HOME)).toBeNull();
        } finally {
            stop();
        }
    });
});

describe('a 426 app_too_old from the community is the full-screen Update required', () => {
    it('the wrapper hears it from the phone\'s own community, names the node\'s minimum, and hands the answer back as it was', async () => {
        noteHealthAnswer(HOME, { version: '1.5.0' });
        answers[`${HOME}/api/posts`] = { status: 426, body: { error: 'app_too_old', minAppVersion: '1.5.0' } };
        const heard: string[] = [];
        const stop = onAppRefused((v) => heard.push(v));
        try {
            const res = await fetch(`${HOME}/api/posts`);
            expect(res.status).toBe(426);
            expect(await res.json()).toEqual({ error: 'app_too_old', minAppVersion: '1.5.0' });
        } finally {
            stop();
        }
        expect(heard).toEqual(['1.5.0']);
    });

    it('never from another host, nor for another 426, nor without a version', async () => {
        noteHealthAnswer(OTHER, { version: '1.5.0' });
        noteHealthAnswer(HOME, { version: '1.5.0' });
        answers[`${OTHER}/api/posts`] = { status: 426, body: { error: 'app_too_old', minAppVersion: '1.5.0' } };
        answers[`${HOME}/api/a`] = { status: 426, body: { error: 'something_else', minAppVersion: '1.5.0' } };
        answers[`${HOME}/api/b`] = { status: 426, body: { error: 'app_too_old' } };
        const heard: string[] = [];
        const stop = onAppRefused((v) => heard.push(v));
        try {
            await fetch(`${OTHER}/api/posts`);
            await fetch(`${HOME}/api/a`);
            await fetch(`${HOME}/api/b`);
        } finally {
            stop();
        }
        expect(heard).toEqual([]);
    });

    it('the gate puts the block up at once, mid-use, and an answer already on its way cannot take it straight down', async () => {
        let t = 0;
        let release: (d: ForceUpdateDecision) => void = () => {};
        const shown: Array<UpdateBlockShown | null> = [];
        const gate = createForceUpdateGate({
            now: () => t,
            check: () => new Promise<ForceUpdateDecision>((resolve) => { release = resolve; }),
            show: (b) => shown.push(b),
        });
        const started = gate.start('active');
        t += 60_000;
        gate.refused('1.5.0');
        expect(shown).toEqual([{ version: '1.5.0' }]);
        // The cold start's question answers "clear" late: it was asked before the refusal, so it says nothing now.
        release({ kind: 'clear' });
        await started;
        expect(shown).toEqual([{ version: '1.5.0' }]);
        // Not a version: nothing.
        gate.refused('soon');
        expect(shown).toEqual([{ version: '1.5.0' }]);
    });
});
