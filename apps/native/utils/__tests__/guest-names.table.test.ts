/**
 * G2 part 2, the invariant on the phone: a guest's line is named by the newest roster row this phone has for that key, in
 * every state (in, left, removed), on the chat's first opening after the app starts and after (WALK 3, 16 Nov: a guest who
 * left was a key fragment on their old lines; the web's first opening read "<key8> · no longer in this group").
 *
 * The web's table (apps/pwa/src/lib/guest-names.table.test.ts), run through this app's own code: utils/guest-chat-live.ts
 * guestRosterRows (the rows components/GroupChatView.tsx opens the chat again with when they come) and
 * utils/group-line-display.ts nameSigner (the name a line shows). On the phone the chat already opens again when the rows
 * come (GroupChatView's effect), so a first opening and a reopening read the same; held here so it stays that way. Who a
 * key may go to is held beside it: only a guest in the chat by the host's list read now.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GROUP_LINE_NOT_IN_GROUP, nameSigner, type DisplayRosterRow } from '../group-line-display';

const ANA = 'a'.repeat(64);
const SOL = 'e'.repeat(64);
const GROUP = 'grp-garden';
const SOL_LINE = 'Sol · riverside.example · guest';
const solsLine = { authorPubkey: SOL, authorCallsign: SOL.slice(0, 8) };

/** The host's list (GET /api/groups/:id/guests), and this phone's store, which a restart keeps. */
const world = vi.hoisted(() => ({
    listed: [] as Array<{ key: string; home: string; name: string; state: string }>,
    store: new Map<string, string>(),
    reads: 0,
}));

vi.mock('react-native', () => ({ DeviceEventEmitter: { emit: () => {}, addListener: () => ({ remove: () => {} }) } }));
vi.mock('../node-post', () => ({
    signedGet: vi.fn(async (_node: string, path: string) => {
        if (path !== `/api/groups/${GROUP}/guests`) throw new Error(`unexpected GET ${path}`);
        world.reads++;
        return new Response(JSON.stringify({ guests: world.listed, on: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
    signedPost: vi.fn(), signedDelete: vi.fn(),
}));
vi.mock('../member-statements', () => ({ signRelayEnvelopeStatement: vi.fn() }));
vi.mock('../node-profile', () => ({ fetchNodeProfile: async () => null, getCachedNodeProfile: async () => null, groupGuestsOn: () => true }));
vi.mock('../outside-mail', () => {
    class OutsideMailError extends Error { constructor(public status: number, message: string) { super(message); } }
    return {
        OutsideMailError,
        answerOf: async (res: Response) => { if (!res.ok) throw new OutsideMailError(res.status, `HTTP ${res.status}`); return res.json(); },
        mailDevice: async () => 'device-1', myHome: async () => 'hillside.example',
    };
});
vi.mock('../outside-chat-live', () => ({
    outsideContext: async () => ({
        nodeUrl: 'https://hillside.example', identity: { publicKey: ANA, privateKey: '11'.repeat(32), callsign: 'Ana' }, isBlocked: async () => false,
        store: { getMeta: async (k: string) => world.store.get(k) ?? null, setMeta: async (k: string, v: string) => { world.store.set(k, v); } },
    }),
}));

type Live = typeof import('../guest-chat-live');
/** The app starting again: the module's memory is empty; the phone's store stays. */
async function appStart(): Promise<Live> {
    vi.resetModules();
    return import('../guest-chat-live');
}

/** One opening of the group chat as GroupChatView makes it, once its rows came: who a key may go to, and Sol's line's name. */
async function open(live: Live) {
    const guests = await live.guestRosterRows(GROUP);
    const members: DisplayRosterRow[] = [{ memberPubkey: ANA, callsign: 'Ana' }];
    return {
        keyTo: [ANA, ...guests.shown.map((g) => g.memberPubkey)],
        name: nameSigner(SOL, solsLine, { roster: [...members, ...guests.shown, ...guests.named] }),
    };
}

const SOL_IN = { key: SOL, home: 'riverside.example', name: 'Sol', state: 'in' };
type State = 'in' | 'left' | 'removed';
const LISTED: Record<State, typeof world.listed> = { in: [SOL_IN], left: [], removed: [] };

beforeEach(() => { world.listed = []; world.store.clear(); world.reads = 0; });
afterEach(() => { vi.resetModules(); });

const TABLE: Array<[State, 'first' | 'reopen', { name: string; hint: string | null; keyToSol: boolean }]> = [
    ['in', 'first', { name: SOL_LINE, hint: null, keyToSol: true }],
    ['in', 'reopen', { name: SOL_LINE, hint: null, keyToSol: true }],
    ['left', 'first', { name: SOL_LINE, hint: GROUP_LINE_NOT_IN_GROUP, keyToSol: false }],
    ['left', 'reopen', { name: SOL_LINE, hint: GROUP_LINE_NOT_IN_GROUP, keyToSol: false }],
    ['removed', 'first', { name: SOL_LINE, hint: GROUP_LINE_NOT_IN_GROUP, keyToSol: false }],
    ['removed', 'reopen', { name: SOL_LINE, hint: GROUP_LINE_NOT_IN_GROUP, keyToSol: false }],
];

describe("phone: a guest's line is named by the newest row this phone has, in every state, first opening and after", () => {
    it.each(TABLE)('Sol %s, %s opening', async (state, opening, want) => {
        // An earlier start saw Sol in the chat (the row this phone keeps), then the host's word moved to `state`.
        world.listed = [SOL_IN];
        await open(await appStart());
        world.listed = LISTED[state];
        const live = await appStart();
        const first = await open(live);
        const got = opening === 'first' ? first : await open(live);
        expect({ name: got.name.name, hint: got.name.nameHint, keyToSol: got.keyTo.includes(SOL) }).toEqual(want);
    });

    it("a guest this phone never saw, gone before the first read: the node's word, \"no longer in this group\"", async () => {
        const got = await open(await appStart());
        expect(got.name).toMatchObject({ name: SOL.slice(0, 8), nameHint: GROUP_LINE_NOT_IN_GROUP });
    });

    it("the host's list unread (an error): nobody is given a key; each guest named by the row kept, no hint for one last seen in", async () => {
        world.listed = [SOL_IN];
        await open(await appStart());
        const live = await appStart();
        const fetch = (await import('../node-post')).signedGet as unknown as ReturnType<typeof vi.fn>;
        fetch.mockImplementationOnce(async () => new Response('{}', { status: 503 }));
        const got = await open(live);
        expect(got.keyTo).toEqual([ANA]);
        expect(got.name).toMatchObject({ name: SOL_LINE, nameHint: null });
    });
});

describe('GroupChatView gives the keyring only the guests in the chat, names lines by the rest too, and opens again when they come (source)', () => {
    const view = readFileSync(resolve(__dirname, '../../components/GroupChatView.tsx'), 'utf8');
    it('noteShownRoster: the members and guests in the chat (.shown), never the kept names', () => {
        const call = view.match(/ring\.noteShownRoster\(([^;]*)\);/)?.[1] ?? '';
        expect(call).toContain('guestRowsRef.current.shown');
        expect(call).not.toContain('named');
    });
    it('the rows that come open the chat again, whichever list they fill', () => {
        expect(view).toMatch(/rows\.shown\.length === 0 && rows\.named\.length === 0\)\) return;\s*guestRowsRef\.current = rows;\s*if \(lastAnswer\.current\) openThreadRef\.current\(lastAnswer\.current\);/);
    });
    it('the lines are named by the members, the guests in the chat, then those no longer in it', () => {
        expect(view).toMatch(/openGroupThread\(ring, answer, \[[^\n]*\.\.\.guests\.shown, \.\.\.guests\.named\]\)/);
    });
});
