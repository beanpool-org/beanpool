/**
 * G2 part 2, the invariant on the web: a guest's line is named by the newest roster row this browser has for that key, in
 * every state (in, left, removed), on the chat's first opening after a page load and after (WALK 3, 16 Nov: the first
 * opening read "<key8> · no longer in this group" while the guest was in, and a guest who left was a key fragment for good).
 *
 * One table over (the guest's state at the host now) x (first opening after a page load / reopening in the same page), run
 * through this app's own code: lib/guest-chat-live.ts guestRowsKnown (the rows MessagesPage reads, and its call to read the
 * open chat again when they come) and lib/group-line-display.ts nameSigner (the name a line shows). The phone runs the same
 * table (apps/native/utils/__tests__/guest-names.table.test.ts). Who a key may go to is held beside it: only a guest in the
 * chat by the host's list read now.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GROUP_LINE_NOT_IN_GROUP, nameSigner, type DisplayRosterRow } from './group-line-display';

const ANA = 'a'.repeat(64);
const SOL = 'e'.repeat(64);
const GROUP = 'grp-garden';
const SOL_LINE = 'Sol · riverside.example · guest';
// The node's word for a key it knows no member for: the first 8 of it (engine/enterprise-thread.ts authorCallsign).
const solsLine = { authorPubkey: SOL, authorCallsign: SOL.slice(0, 8) };

/** The host's list (GET /api/groups/:id/guests: a convenor's has those asked and in), and this browser's store, which a page load keeps. */
const world = vi.hoisted(() => ({
    listed: [] as Array<{ key: string; home: string; name: string; state: string }>,
    store: new Map<string, string>(),
    reads: 0,
    /** Whether the community's own info reads (it says whether guests are on here). */
    infoReads: true,
}));

vi.mock('./api', () => ({
    signedMailFetch: vi.fn(async (method: string, _node: string, path: string) => {
        if (method !== 'GET' || path !== `/api/groups/${GROUP}/guests`) throw new Error(`unexpected ${method} ${path}`);
        world.reads++;
        return new Response(JSON.stringify({ guests: world.listed, on: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
    signRelayEnvelopeFor: vi.fn(),
}));
vi.mock('./visitor-lobby-gate', () => ({
    communityInfoOnce: async () => { if (!world.infoReads) throw new Error('offline'); return { features: { groupGuests: true, outsideMessages: true } }; },
}));
vi.mock('./outside-mail', () => {
    class OutsideMailError extends Error { constructor(public status: number, message: string) { super(message); } }
    return {
        OutsideMailError,
        answerOf: async (res: Response) => { if (!res.ok) throw new OutsideMailError(res.status, `HTTP ${res.status}`); return res.json(); },
        mailDevice: async () => 'device-1', myHome: async () => 'hillside.example',
        outsideContext: async () => ({
            nodeUrl: 'https://hillside.example', identity: { publicKey: ANA, privateKey: '11'.repeat(32), callsign: 'Ana' }, isBlocked: async () => false,
            store: {
                getMeta: async (me: string, k: string) => world.store.get(`${me}|${k}`) ?? null,
                setMeta: async (me: string, k: string, v: string) => { world.store.set(`${me}|${k}`, v); },
            },
        }),
    };
});

type Live = typeof import('./guest-chat-live');
/** A page load: the module's memory starts empty; the browser's store stays. */
async function pageLoad(): Promise<Live> {
    vi.resetModules();
    return import('./guest-chat-live');
}
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

/**
 * One opening of the group chat as MessagesPage.loadGroupChat makes it: the rows known now, the roster the keyring is given
 * (members and the guests in the chat), and the rows lines are named by (those, then the guests no longer in it).
 */
function open(live: Live, onNew: () => void) {
    const guests = live.guestRowsKnown(GROUP, onNew);
    const members: DisplayRosterRow[] = [{ memberPubkey: ANA, callsign: 'Ana' }];
    const roster = [...members, ...guests.shown];
    return {
        keyTo: [ANA, ...guests.shown.map((g) => g.memberPubkey)],
        name: nameSigner(SOL, solsLine, { roster: [...roster, ...guests.named] }),
    };
}

/**
 * The first opening after a page load, all the way: the rows known at once (none), then, when the read beside it brings
 * rows other than those, the chat read again once (MessagesPage's onNew: loadMessages), which is what the member then sees.
 */
async function firstOpening(live: Live) {
    let again = 0;
    let shown = open(live, () => { again++; });
    await settle();
    if (again) shown = open(live, () => { again++; });
    await settle();
    return { ...shown, readAgain: again };
}
async function reopening(live: Live) {
    let again = 0;
    const shown = open(live, () => { again++; });
    await settle();
    return { ...shown, readAgain: again };
}

const SOL_IN = { key: SOL, home: 'riverside.example', name: 'Sol', state: 'in' };
type State = 'in' | 'left' | 'removed';
/** What the host lists for each state: it lists only those asked or in (engine/group-guests.ts listGroupGuests). */
const LISTED: Record<State, typeof world.listed> = { in: [SOL_IN], left: [], removed: [] };

beforeEach(() => { world.listed = []; world.store.clear(); world.reads = 0; world.infoReads = true; });
afterEach(() => { vi.resetModules(); });

// state x opening -> the name Sol's line shows, the hint beside it, whether a key may go to Sol, and whether the chat was read again.
const TABLE: Array<[State, 'first' | 'reopen', { name: string; hint: string | null; keyToSol: boolean; readAgain: number }]> = [
    ['in', 'first', { name: SOL_LINE, hint: null, keyToSol: true, readAgain: 1 }],
    ['in', 'reopen', { name: SOL_LINE, hint: null, keyToSol: true, readAgain: 0 }],
    ['left', 'first', { name: SOL_LINE, hint: GROUP_LINE_NOT_IN_GROUP, keyToSol: false, readAgain: 1 }],
    ['left', 'reopen', { name: SOL_LINE, hint: GROUP_LINE_NOT_IN_GROUP, keyToSol: false, readAgain: 0 }],
    ['removed', 'first', { name: SOL_LINE, hint: GROUP_LINE_NOT_IN_GROUP, keyToSol: false, readAgain: 1 }],
    ['removed', 'reopen', { name: SOL_LINE, hint: GROUP_LINE_NOT_IN_GROUP, keyToSol: false, readAgain: 0 }],
];

describe("web: a guest's line is named by the newest row this browser has, in every state, first opening and after", () => {
    it.each(TABLE)('Sol %s, %s opening', async (state, opening, want) => {
        // An earlier page saw Sol in the chat (the row this browser keeps), then the host's word moved to `state`.
        world.listed = [SOL_IN];
        await reopening(await pageLoad());
        world.listed = LISTED[state];
        const live = await pageLoad();
        const first = await firstOpening(live);
        const got = opening === 'first' ? first : await reopening(live);
        expect({ name: got.name.name, hint: got.name.nameHint, keyToSol: got.keyTo.includes(SOL), readAgain: got.readAgain }).toEqual(want);
    });

    it('a guest this browser never saw, gone before the first read: the node\'s word, "no longer in this group" (nothing kept to name them by)', async () => {
        world.listed = [];
        const got = await firstOpening(await pageLoad());
        expect(got.name).toMatchObject({ name: SOL.slice(0, 8), nameHint: GROUP_LINE_NOT_IN_GROUP });
        expect(got.readAgain).toBe(0);
    });

    it('a guest asked again (a convenor\'s list has them `invited`): their old lines take the newest row, never a key', async () => {
        world.listed = [SOL_IN];
        await reopening(await pageLoad());
        world.listed = [{ ...SOL_IN, name: 'Sol R', state: 'invited' }];
        const got = await firstOpening(await pageLoad());
        expect(got.name).toMatchObject({ name: 'Sol R · riverside.example · guest', nameHint: GROUP_LINE_NOT_IN_GROUP });
        expect(got.keyTo).toEqual([ANA]);
    });

    it('a member of the group is named as a member even when a kept guest row has the same key', async () => {
        world.listed = [SOL_IN];
        await reopening(await pageLoad());
        world.listed = [];
        const live = await pageLoad();
        await firstOpening(live);
        const guests = live.guestRowsKnown(GROUP);
        const roster: DisplayRosterRow[] = [{ memberPubkey: SOL, callsign: 'Sol the member' }, ...guests.shown, ...guests.named];
        expect(nameSigner(SOL, solsLine, { roster })).toMatchObject({ name: 'Sol the member', nameHint: null });
    });

    it("the community's info unread (offline): nobody is given a key, and each guest keeps the row kept here, unmarked", async () => {
        world.listed = [SOL_IN];
        await reopening(await pageLoad());
        world.infoReads = false;
        const got = await firstOpening(await pageLoad());
        expect(got.keyTo).toEqual([ANA]);
        expect(got.name).toMatchObject({ name: SOL_LINE, nameHint: null });
        // Back online: Sol is still in, shown and named as before (nothing was marked out meanwhile).
        world.infoReads = true;
        const back = await firstOpening(await pageLoad());
        expect(back.keyTo).toEqual([ANA, SOL]);
        expect(back.name).toMatchObject({ name: SOL_LINE, nameHint: null });
    });

    it('the read beside the chat is once a minute: a reopening asks the host nothing more', async () => {
        world.listed = [SOL_IN];
        const live = await pageLoad();
        await firstOpening(live);
        const reads = world.reads;
        await reopening(live);
        await reopening(live);
        expect(world.reads).toBe(reads);
    });
});

describe('MessagesPage gives the keyring only the guests in the chat, and names lines by the rest too (source)', () => {
    const page = readFileSync(resolve(__dirname, '../pages/MessagesPage.tsx'), 'utf8');
    it('noteShownRoster: the members and guests.shown, never the kept names', () => {
        const call = page.match(/ring\.noteShownRoster\(([^;]*)\);/)?.[1] ?? '';
        expect(call).toContain('guests.shown');
        expect(call).not.toMatch(/named|formerGuests/);
    });
    it('the chat is read again when the rows come, only while it is still the one open', () => {
        expect(page).toMatch(/guestRowsKnown\(convId, \(\) => \{ if \(activeConvIdRef\.current === convId\) void loadMessages\(convId\); \}\)/);
    });
    it('the lines are named by the roster and the guests no longer in the chat', () => {
        expect(page).toMatch(/openGroupThread\(ring, [^)]*\[\.\.\.roster, \.\.\.formerGuests\]/);
    });
});
