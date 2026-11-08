// @vitest-environment jsdom
/**
 * People → Invites, the names box, against the names list's real flows (#2974 round 3): ticking "Add them to the names list"
 * opens the list on this phone, and the list says its warnings once (core forgets the kept words and rewrites the names this
 * phone saw, on that open). So what that open says is shown on Invites, in the amber box with "Open the names list", and
 * stays until dismissed or the list is opened; the list's own screen opening after it rightly says nothing again.
 *
 * Nothing contacts a node: `fetch` plays the community (names-fake-node.ts, the same node names-list.test.ts uses), the keys
 * and boxes are real, and the hook and boxes are People's own (components/InviteNamesBoxes.tsx).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) }));
const mem = vi.hoisted(() => new Map<string, string>());
const secrets = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.delete(key); }),
    },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async (key: string) => secrets.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { secrets.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { secrets.delete(key); }),
}));
vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, testID, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = () => onPress({});
        if (disabled) attrs.disabled = true;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'),
        TextInput: (p: Record<string, any>) => createElement('input', { 'data-testid': p.testID, value: p.value ?? '', onChange: (e: { target: { value: string } }) => p.onChangeText?.(e.target.value) }),
        ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, flatten: (s: unknown) => s },
    };
});
const pushed = vi.hoisted(() => [] as string[]);
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    return {
        router: { push: (to: string) => { pushed.push(to); } },
        useFocusEffect: (cb: () => void | (() => void)) => { useEffect(() => cb(), [cb]); },
    };
});
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});
vi.mock('../member-statements', () => ({ makeOfflineTicket: async () => 'BP-TICKET' }));
vi.mock('../node-admin', () => ({ askNodeRole: async () => null, persistNodeRole: async () => {}, readPersistedNodeRole: async () => undefined, rememberNodeRole: () => {} }));

import { getPublicKey } from '@noble/ed25519';
import { namesKeyQr, t } from '@beanpool/core';
import { bytesToHex } from '../crypto';
import {
    DEVICE_NAMES_STORE as STORE, NAMES_COPY, openNamesList, checkEachOther, saveNamesEntry, newEntryId, removeOldKey, readNamesPinFrom,
    type NamesOpened,
} from '../names-list';
import type { BeanPoolIdentity } from '../identity';
import { keyLineWords } from '../../components/key-lines';
import { InviteNamesBoxes, useInviteNames } from '../../components/InviteNamesBoxes';
import { FakeNode, type Admin, type Sent } from './names-fake-node';

const COMMUNITY = 'https://mullum.beanpool.org';
const say = (text: string) => text.split('\n\n').map(keyLineWords).join('\n\n');

async function admin(callsign: string): Promise<BeanPoolIdentity> {
    const seed = new Uint8Array(randomBytes(32));
    return { publicKey: bytesToHex(await getPublicKey(seed)), privateKey: bytesToHex(seed), callsign } as BeanPoolIdentity;
}
const role = (who: BeanPoolIdentity, r: 'owner' | 'admin' = 'admin'): Admin => ({ pubkey: who.publicKey, callsign: who.callsign, role: r });

let node: FakeNode;
beforeEach(() => {
    mem.clear();
    secrets.clear();
    pushed.length = 0;
    node = new FakeNode();
    (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
        const req: Sent = { url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body ?? '' };
        const a = node.answer(req);
        const body = a.body === undefined ? undefined : JSON.parse(JSON.stringify(a.body));
        return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => { if (body === undefined) throw new Error('no body'); return body; } };
    });
});

const open = async (me: BeanPoolIdentity): Promise<NamesOpened> => {
    const r = await openNamesList(COMMUNITY, me, STORE);
    if (!r.ok) throw new Error(`${me.callsign}'s open: ${r.status} ${r.code} ${r.message}`);
    return r.value;
};
const meet = async (a: BeanPoolIdentity, b: BeanPoolIdentity) => {
    for (const [x, y] of [[a, b], [b, a]] as const) expect((await checkEachOther(STORE, x, COMMUNITY, node.stateFor(x.publicKey), namesKeyQr(y.publicKey))).ok).toBe(true);
};
/** Owen makes the list's first key, meets each of the others, and every phone opens it until each holds the key. */
async function community(names: string[]): Promise<BeanPoolIdentity[]> {
    const phones = await Promise.all(names.map((n) => admin(n)));
    node.admins = phones.map((p, i) => role(p, i === 0 ? 'owner' : 'admin'));
    expect((await open(phones[0])).plan.kind).toBe('ready');
    for (const p of phones.slice(1)) await meet(phones[0], p);
    for (let i = 0; i < 2; i++) for (const p of phones) await openNamesList(COMMUNITY, p, STORE);
    for (const p of phones) expect((await open(p)).plan.kind).toBe('ready');
    return phones;
}
/** The rows a standby holds, and putting them back: the server as an older copy had it. */
const snapshot = () => ({ gens: new Map(node.gens), shares: new Map(node.shares), entries: node.entries.map((e) => ({ ...e })), deleted: [...node.deleted], marks: new Set(node.marks) });
const putBack = (c: ReturnType<typeof snapshot>) => {
    node.gens = new Map(c.gens); node.shares = new Map(c.shares); node.entries = c.entries.map((e) => ({ ...e })); node.deleted = [...c.deleted]; node.marks = new Set(c.marks);
};

// ── People → Invites, as People draws it for an owner or admin ──────────────────────────────────────────────────────────

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function Invites({ me }: { me: BeanPoolIdentity }) {
    const names = useInviteNames({ anchorUrl: COMMUNITY, identity: me, offered: true, here: true, committee: true, online: true, voucherBudget: 1000 });
    return createElement(InviteNamesBoxes, { names, busy: false, onInviteExisting: () => {} });
}
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const shown = () => Array.from(host.querySelectorAll('[data-testid="invite-names-notice"]')).map((n) => n.textContent ?? '');
/** Until the list's open (real keys and boxes) has settled: no spinner. */
const settle = async () => {
    for (let i = 0; i < 400; i++) {
        await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
        if (!host.querySelector('[data-spinner]') && i > 3) return;
    }
    throw new Error('the open never settled');
};
const tick = async () => { await act(async () => { q('invite-names-box')!.click(); }); await settle(); };

describe('People → Invites: what ticking the names box opened is said there, once (#2974 round 3)', () => {
    it('a server put back to the copy from before 2 names Bea added: the lost-entries sentence is on Invites with "Open the names list"; the list screen\'s open after it says nothing again, as core intends', async () => {
        const [, bea] = await community(['Owen', 'Bea']);
        const copy = snapshot();
        const b = await open(bea);
        for (const n of ['One', 'Two']) expect((await saveNamesEntry(COMMUNITY, bea, STORE, b, { name: n, note: '' }, undefined, newEntryId())).ok).toBe(true);
        expect((await readNamesPinFrom(STORE, bea.publicKey, COMMUNITY))!.seen.length).toBe(2);
        putBack(copy);

        await act(async () => { root.render(createElement(Invites, { me: bea }) as any); });
        await settle();
        expect(q('invite-names-notices'), 'nothing said before the box is ticked').toBeNull();
        await tick();
        expect(q('invite-names-refused')).toBeNull();
        expect(shown()).toEqual([say(NAMES_COPY.lostEntries(2))]);
        expect(q('invite-names-open-list')?.textContent).toBe(t('Open the names list'));

        // The list's own screen opens next (its focus effect): the read already counted them, so it rightly says nothing.
        const later = await open(bea);
        expect(later.plan.kind).toBe('ready');
        expect(later.notices).toEqual([]);
        // Invites still says it: unticking the box keeps it; only Dismiss or "Open the names list" ends it.
        await act(async () => { q('invite-names-box')!.click(); });
        expect(shown()).toEqual([say(NAMES_COPY.lostEntries(2))]);
        await act(async () => { q('invite-names-open-list')!.click(); });
        expect(pushed).toEqual(['/names-list']);
        expect(q('invite-names-notices')).toBeNull();
        // Ticked again: the list opens afresh and has nothing new to say.
        await tick();
        expect(q('invite-names-notices')).toBeNull();
    });

    it('a server put back past a key change refuses the open: Invites says the refusal in its own words (the put-back card), not "can’t write right now", and the estimate of names lost, kept until Dismiss', async () => {
        const [owen, bea, cy] = await community(['Owen', 'Bea', 'Cy']);
        const copy = snapshot();
        // Owen removes Cy's old key and they meet again: key 2, which the older copy won't have.
        await removeOldKey(STORE, owen, COMMUNITY, cy.publicKey);
        await open(owen);
        await meet(owen, cy);
        for (const p of [owen, cy, bea]) await open(p);
        const b = await open(bea);
        for (const n of ['One', 'Two']) expect((await saveNamesEntry(COMMUNITY, bea, STORE, b, { name: n, note: '' }, undefined, newEntryId())).ok).toBe(true);
        await open(cy);
        putBack(copy);

        await act(async () => { root.render(createElement(Invites, { me: bea }) as any); });
        await settle();
        await tick();
        const refused = q('invite-names-refused')?.textContent ?? '';
        expect(refused).toBe(say(NAMES_COPY.refusedRolledBack(1, 2)));
        expect(refused).not.toBe(say(NAMES_COPY.notReady));
        expect(shown()).toEqual([say(NAMES_COPY.lostSinceCopy(2))]);
        // The estimate is the put-back card's, said on every refused open: the list's screen says it too (exact after Put the key history back).
        const later = await open(bea);
        expect(later.plan).toMatchObject({ kind: 'refused', reason: 'rolled_back' });
        expect(later.notices).toEqual([NAMES_COPY.lostSinceCopy(2)]);
        await act(async () => { q('invite-names-notices-dismiss')!.click(); });
        expect(q('invite-names-notices')).toBeNull();
        expect(pushed).toEqual([]);
    });
});
