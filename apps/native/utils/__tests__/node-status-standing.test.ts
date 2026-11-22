// @vitest-environment jsdom
/**
 * A member whose account is suspended in the community in use (the probe's `standing`: server routes/community.ts, review of
 * #3359): the app's own ask (app/NodeStatusContext.tsx, at launch and each time it comes to the front) still says 'member', so
 * nothing of theirs is taken away and no not-recognised screen is shown, and notes it for Message (utils/standing-here.ts), which
 * goes by it where it gets no answer of its own at the tap (message-after-switch-standing.test.ts). Only a definite answer
 * changes what was noted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ME = { publicKey: 'e5'.repeat(32), privateKey: 'f0'.repeat(32), callsign: 'Me' };
const RIVERSIDE = 'https://riverside.example';
const app = vi.hoisted(() => ({
    toFront: null as null | (() => void),
    /** What the community answers the next ask: a status and a body, or no answer at all. */
    answers: [] as Array<[number, unknown] | 'no answer'>,
    asked: [] as string[],
    blocks: [] as string[],
}));
vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    DeviceEventEmitter: { addListener: () => ({ remove() {} }), emit() {} },
    AppState: { addEventListener: (_event: string, fn: (next: string) => void) => { app.toFront = () => fn('active'); return { remove() {} }; } },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: async (k: string) => (k === 'beanpool_anchor_url' ? 'https://riverside.example' : null), setItem: async () => {}, removeItem: async () => {} },
}));
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID, getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: ME }) }));
vi.mock('../membership-probe', () => ({
    fetchMembership: async (community: string) => {
        app.asked.push(community);
        const answer = app.answers.shift();
        if (!answer || answer === 'no answer') throw new Error('no answer');
        return new Response(JSON.stringify(answer[1]), { status: answer[0] });
    },
}));
vi.mock('../nodes', () => ({ clearGuestNode: async () => {} }));
vi.mock('../blocklist', () => ({
    blocksAtMember: async () => { app.blocks.push('member'); },
    communityKeepsNoBlocks: async () => { app.blocks.push('none kept'); },
}));

import { NodeStatusProvider, useNodeStatus } from '../../app/NodeStatusContext';
import { resetStandingHereForTests, suspendedHere } from '../standing-here';

let root: Root;
let recognition = '';
function Shown() {
    recognition = useNodeStatus().recognition;
    return null;
}
const settled = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); });
const here = () => suspendedHere(ME.publicKey, RIVERSIDE);

const MEMBER: [number, unknown] = [200, { isMember: true, callsign: 'Me', standing: 'member' }];
const SUSPENDED: [number, unknown] = [200, { isMember: true, callsign: 'Me', standing: 'suspended' }];

beforeEach(() => {
    resetStandingHereForTests();
    app.answers = []; app.asked = []; app.blocks = [];
    root = createRoot(document.createElement('div'));
});
afterEach(() => { act(() => root.unmount()); });

async function launched(answer: [number, unknown] | 'no answer'): Promise<void> {
    app.answers = [answer];
    act(() => root.render(createElement(NodeStatusProvider, null, createElement(Shown)) as any));
    await settled();
}
async function toFront(answer: [number, unknown] | 'no answer'): Promise<void> {
    app.answers = [answer];
    app.toFront!();
    await settled();
}

describe('how the account stands in the community in use, as the app itself asks', () => {
    it.each([
        { name: 'a member', answer: MEMBER, says: 'member', suspended: false },
        { name: 'suspended: a member still, with its blocks and its tabs, and noted', answer: SUSPENDED, says: 'member', suspended: true },
        { name: 'a server that says nothing of how the account stands', answer: [200, { isMember: true, callsign: 'Me' }], says: 'member', suspended: false },
        { name: 'no member, whatever else it says', answer: [200, { isMember: false, standing: 'suspended' }], says: 'stranger', suspended: false },
        { name: 'closed', answer: [403, { code: 'account_closed' }], says: 'closed', suspended: false },
        { name: 'no answer', answer: 'no answer', says: 'unknown', suspended: false },
    ] as Array<{ name: string; answer: [number, unknown] | 'no answer'; says: string; suspended: boolean }>)('at launch: $name', async ({ answer, says, suspended }) => {
        await launched(answer);
        expect(app.asked).toEqual([RIVERSIDE]);
        expect(recognition).toBe(says);
        expect(here()).toBe(suspended);
        if (says === 'member') expect(app.blocks).toEqual(['member']);
    });

    it.each([
        { name: 'lifted', answer: MEMBER, says: 'member', suspended: false },
        { name: 'suspended still', answer: SUSPENDED, says: 'member', suspended: true },
        { name: 'closed since', answer: [403, { code: 'account_closed' }], says: 'closed', suspended: false },
        { name: 'no answer: what it last said stands', answer: 'no answer', says: 'unknown', suspended: true },
        { name: 'busy, so no definite answer: what it last said stands', answer: [503, { error: 'busy' }], says: 'unknown', suspended: true },
    ] as Array<{ name: string; answer: [number, unknown] | 'no answer'; says: string; suspended: boolean }>)('suspended, then to the front again: $name', async ({ answer, says, suspended }) => {
        await launched(SUSPENDED);
        expect(here()).toBe(true);
        await toFront(answer);
        expect(recognition).toBe(says);
        expect(here()).toBe(suspended);
    });
});
