// @vitest-environment jsdom
/**
 * Profile S1 (scratch/fable-design/DESIGN-per-community-profile-fable.md §4): your name and picture follow the community
 * you're in. The header (components/GlobalHeader.tsx) is drawn for real with the real avatar (components/MemberAvatar.tsx),
 * the real hook under both (utils/use-own-profile.ts) and the real switch notice (utils/community-switch.ts). The phone's
 * copy of each community stands in at utils/db getMemberProfile: it answers with the own row of the copy the anchor
 * (`beanpool_anchor_url`) names, as getDb opens it. Nothing here contacts a node.
 *
 * - Marty, 28 Oct: three different pictures of himself on one phone. The header read the own row once and never after a
 *   switch, so it kept the community before's picture (§2.1).
 * - Damo, 29 Oct (a): the header avatar BLANK on Edit Profile. A picture that fails to load was a blank disc (§2.4).
 * - Damo, 29 Oct (b): an OLD photo on other tabs after a change. Nothing passed `updatedAt` for "me", so a new photo at
 *   the same address (a node from before versioned face URLs) stayed the one in the image cache (§2.5).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = React;
// Bundled pictures load as their file's name, so the ready-made picture a key picks can be told from a photo.
vi.hoisted(() => {
    const Loader = (process as any).getBuiltinModule('node:module');
    const path = (process as any).getBuiltinModule('node:path');
    const asName = (m: { exports: unknown }, filename: string) => { m.exports = `asset:${path.basename(filename)}`; };
    Loader._extensions['.jpg'] = asName;
    Loader._extensions['.png'] = asName;
    Loader._extensions['.webp'] = asName;
});

const alerts = vi.hoisted(() => ({ said: [] as string[], buttons: [] as Array<{ text?: string; onPress?: () => unknown }> }));
/** DeviceEventEmitter, for real: `profile_updated` reaches the hook as it does on a phone. */
const events = vi.hoisted(() => {
    const listeners = new Map<string, Set<(payload?: unknown) => void>>();
    return {
        listeners,
        addListener: (name: string, fn: (payload?: unknown) => void) => {
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name)!.add(fn);
            return { remove: () => { listeners.get(name)?.delete(fn); } };
        },
        emit: (name: string, payload?: unknown) => { for (const fn of [...(listeners.get(name) ?? [])]) fn(payload); },
    };
});
vi.mock('react-native', async () => {
    const native = (await import('./profile-events-words-harness')).nativeMock(alerts);
    return { ...native, DeviceEventEmitter: { addListener: events.addListener, emit: events.emit } };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
const nav = vi.hoisted(() => ({ pushed: [] as any[], path: '/' }));
vi.mock('expo-router', () => ({
    router: { push: (to: unknown) => nav.pushed.push(to), replace: (to: unknown) => nav.pushed.push(to), back: () => {}, canGoBack: () => true },
    usePathname: () => nav.path,
    useFocusEffect: (effect: () => void | (() => void)) => { useEffect(() => effect() ?? undefined, [effect]); },
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.2.83' } } }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (n: number) => new Uint8Array(randomBytes(n)), randomUUID: () => 'uuid' };
});
/** expo-image: its source as `src` (a bundled picture by its file's name), and its onError as the image's error. */
vi.mock('expo-image', () => ({
    Image: (props: any) => createElement('img', {
        src: typeof props.source === 'object' && props.source?.uri ? props.source.uri : String(props.source),
        'aria-label': props.accessibilityLabel,
        onError: props.onError ? () => props.onError({ error: 'failed' }) : undefined,
    }),
}));
const store = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.delete(k); }),
    },
}));
const ME = 'a1'.repeat(32);
/** One account, one phone-wide name: the one the phone was set up with, which is no community's name here. */
const who = vi.hoisted(() => ({ value: { identity: { publicKey: 'a1'.repeat(32), privateKey: 'b2'.repeat(32), callsign: 'PhoneWide' } as any } }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => who.value }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { colors: lightColors, theme: 'light' };
    return { useTheme: () => ctx, useStyles: (make: (t: unknown) => unknown) => make(ctx) };
});
/** Each community's copy on this phone: its own row for the account, by the copy's community. */
const copies = vi.hoisted(() => new Map<string, { callsign: string; avatar_url: string | null; profile_updated_at: string | null }>());
vi.mock('../db', () => ({
    getMemberProfile: vi.fn(async (pk: string) => {
        const anchor = store.get('beanpool_anchor_url') ?? null;
        const row = anchor ? copies.get(anchor) : undefined;
        return row ? { public_key: pk, ...row } : null;
    }),
}));
vi.mock('../../components/NeedsYouIcons', () => ({ NeedsYouIcons: () => null }));
vi.mock('../../services/pillar-sync', () => ({ getLastSyncTime: async () => Date.now() }));

import { bundledAvatarForPubkey } from '@beanpool/core';
import { GlobalHeader } from '../../components/GlobalHeader';
import { communitySwitched } from '../community-switch';

const A = 'https://mullum.example';
const B = 'https://bellingen.example';
const T1 = '2026-10-28T09:00:00.000Z';
const T2 = '2026-10-29T09:00:00.000Z';
/** The ready-made picture this key picks, as the phone bundles it. */
const PRESET = `asset:avatar_${bundledAvatarForPubkey(ME).replace('bundled://', '').replace(/-/g, '_')}.webp`;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    store.clear();
    copies.clear();
    events.listeners.clear();
    nav.pushed.length = 0;
    nav.path = '/';
    store.set('beanpool_anchor_url', A);
    // The avatars' shared address is the phone's (MemberAvatar): a case before may have left it on B.
    communitySwitched();
    globalThis.fetch = vi.fn(async () => { throw new TypeError('offline'); }) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
/** The header avatar's picture: the image inside "Open profile". */
const avatarSrc = () => host.querySelector('[aria-label="Open profile"] img')?.getAttribute('src') ?? null;
async function drawHeader() {
    await act(async () => { root.render(createElement(GlobalHeader)); });
    await settle();
}
/** The phone moves to `url`, as every switch does (use-communities.ts switchCommunity): the anchor, then the notice. */
async function switchTo(url: string) {
    await act(async () => { store.set('beanpool_anchor_url', url); communitySwitched(); });
    await settle();
}
/** A Save here, or a sync that changed the own row (utils/db.ts), says so. */
async function profileUpdated() {
    await act(async () => { events.emit('profile_updated', { pubkey: ME }); });
    await settle();
}

describe('the header follows the community the phone is on', () => {
    it("after a switch it shows row B's picture, resolved against B, never A's", async () => {
        copies.set(A, { callsign: 'Marty', avatar_url: `/api/avatar/${ME}?size=thumb&v=aaaa&k=ka`, profile_updated_at: T1 });
        copies.set(B, { callsign: 'Marty B', avatar_url: `/api/avatar/${ME}?size=thumb&v=bbbb&k=kb`, profile_updated_at: T2 });
        await drawHeader();
        expect(avatarSrc()).toContain(`${A}/api/avatar/${ME}?size=thumb&v=aaaa&k=ka`);

        await switchTo(B);
        expect(avatarSrc()).toContain(`${B}/api/avatar/${ME}?size=thumb&v=bbbb&k=kb`);
        expect(avatarSrc()).not.toContain('v=aaaa');
        expect(avatarSrc()).not.toContain(A);

        // And back: A's own picture again, against A.
        await switchTo(A);
        expect(avatarSrc()).toContain(`${A}/api/avatar/${ME}?size=thumb&v=aaaa&k=ka`);
    });

    it('a community whose copy holds no row for you yet: the preset by key until it lands, never the community before\'s', async () => {
        copies.set(A, { callsign: 'Marty', avatar_url: `/api/avatar/${ME}?size=thumb&v=aaaa`, profile_updated_at: T1 });
        await drawHeader();
        expect(avatarSrc()).toContain('v=aaaa');

        await switchTo(B);
        expect(avatarSrc()).toBe(PRESET);

        // The members sync writes B's row and says so (db.ts ownProfileRowWouldChange → profile_updated).
        copies.set(B, { callsign: 'Marty B', avatar_url: `/api/avatar/${ME}?size=thumb&v=bbbb`, profile_updated_at: T2 });
        await profileUpdated();
        expect(avatarSrc()).toContain(`${B}/api/avatar/${ME}?size=thumb&v=bbbb`);
    });

    it("the avatar opens My Profile with this community's name, never the phone-wide one", async () => {
        copies.set(A, { callsign: 'Marty of Mullum', avatar_url: null, profile_updated_at: null });
        await drawHeader();
        await act(async () => { (host.querySelector('[aria-label="Open profile"]') as HTMLElement).click(); });
        expect(nav.pushed.at(-1)).toEqual({ pathname: '/public-profile', params: { publicKey: ME, callsign: 'Marty of Mullum' } });

        copies.set(B, { callsign: 'Marty of Bellingen', avatar_url: null, profile_updated_at: null });
        await switchTo(B);
        await act(async () => { (host.querySelector('[aria-label="Open profile"]') as HTMLElement).click(); });
        expect(nav.pushed.at(-1)).toEqual({ pathname: '/public-profile', params: { publicKey: ME, callsign: 'Marty of Bellingen' } });
        expect(JSON.stringify(nav.pushed)).not.toContain('PhoneWide');
    });
});

describe("Damo's two (29 Oct)", () => {
    it('(a) a picture that fails to load: the preset by key, never a blank disc', async () => {
        // A `k=` that no longer matches (the photo changed elsewhere, the node re-keyed): the node answers 404.
        copies.set(A, { callsign: 'Damo', avatar_url: `/api/avatar/${ME}?size=thumb&v=old&k=stale`, profile_updated_at: T1 });
        await drawHeader();
        const img = host.querySelector('[aria-label="Open profile"] img')!;
        expect(img.getAttribute('src')).toContain('k=stale');
        await act(async () => { img.dispatchEvent(new Event('error')); });
        expect(avatarSrc()).toBe(PRESET);

        // The row moves on to a new address: that one is tried afresh.
        copies.set(A, { callsign: 'Damo', avatar_url: `/api/avatar/${ME}?size=thumb&v=new&k=fresh`, profile_updated_at: T2 });
        await profileUpdated();
        expect(avatarSrc()).toContain('k=fresh');
    });

    it('(b) a new photo changes the header\'s image source: a new address, or the same address with a new stamp', async () => {
        copies.set(A, { callsign: 'Damo', avatar_url: `/api/avatar/${ME}?size=thumb&v=one`, profile_updated_at: T1 });
        await drawHeader();
        const first = avatarSrc();
        expect(first).toContain('v=one');

        // A versioned node: the address itself moves.
        copies.set(A, { callsign: 'Damo', avatar_url: `/api/avatar/${ME}?size=thumb&v=two`, profile_updated_at: T2 });
        await profileUpdated();
        const second = avatarSrc();
        expect(second).toContain('v=two');
        expect(second).not.toBe(first);

        // A node from before versioned face URLs: one address for every photo, and only the stamp moves. The image cache
        // is keyed by the source, so the source must change with it.
        copies.set(A, { callsign: 'Damo', avatar_url: `/api/avatar/${ME}?size=thumb`, profile_updated_at: T1 });
        await profileUpdated();
        const before = avatarSrc();
        copies.set(A, { callsign: 'Damo', avatar_url: `/api/avatar/${ME}?size=thumb`, profile_updated_at: T2 });
        await profileUpdated();
        const after = avatarSrc();
        expect(after).toContain(`_v=${new Date(T2).getTime()}`);
        expect(after).not.toBe(before);
    });
});
