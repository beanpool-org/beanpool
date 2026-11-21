// @vitest-environment jsdom
/**
 * "Not seen yet" on a deal request in Your deals on the phone (DESIGN-notify-and-backup-asks-fable §4.5; amendment 2 §12.3,
 * slice N4): my request still waiting, and the other person's read cursor in our one chat (db.ts peerReadCursors) from
 * before it. Core decides (packages/beanpool-core not-seen.test.ts); this holds that the sheet hands it the cursor and the
 * chat's being there, nothing else of theirs, and draws the line in light and dark. The sheet is rendered for real
 * (react-native drawn as DOM), as my-deals-standing-render.test.ts does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        FlatList: ({ data, renderItem, keyExtractor, ListEmptyComponent }: Record<string, any>) => (data.length
            ? createElement('div', null, data.map((item: unknown, index: number) => createElement(Fragment, { key: keyExtractor(item) }, renderItem({ item, index }))))
            : ListEmptyComponent),
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} },
        Alert: { alert: vi.fn() },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('expo-router', () => ({ router: { push() {}, navigate() {} } }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => createElement('span', { 'data-icon': 'true' }) }));
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
vi.mock('../../components/ReviewModal', () => ({ ReviewModal: () => null }));
const theme = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors: light, darkColors: dark } = await import('../../constants/colors');
    const colors = () => (theme.dark ? dark : light);
    return {
        useTheme: () => ({ theme: theme.dark ? 'dark' : 'light', colors: colors() }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: theme.dark ? 'dark' : 'light', colors: colors() }),
    };
});

const ME = 'a'.repeat(64);
const ASHA = 'b'.repeat(64);
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const db = vi.hoisted(() => ({ rows: [] as unknown[], cursors: new Map<string, string | null>(), asked: [] as string[][] }));
vi.mock('../db', () => ({
    getPosts: async () => [],
    getMyPosts: async () => [],
    getMarketplaceTransactions: async () => db.rows,
    peerReadCursors: async (_me: string, peers: string[]) => { db.asked.push(peers); return db.cursors; },
}));

import { MyDealsSheet } from '../../components/MyDealsSheet';

/** My request on Asha's offer, made `age` ago and still waiting for her answer. */
const asked = (age: number, over: Record<string, unknown> = {}) => ({
    id: 'tx-1', postId: 'post-1', postTitle: 'Ladder', buyerPublicKey: ME, buyerCallsign: 'Me', sellerPublicKey: ASHA, sellerCallsign: 'Asha',
    postAuthorPublicKey: ASHA, postType: 'offer', amount_c: 500, status: 'requested', createdAt: ago(age), ...over,
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); db.asked.length = 0; });
afterEach(() => { act(() => root.unmount()); host.remove(); db.rows = []; db.cursors = new Map(); theme.dark = false; });

const render = async () => {
    await act(async () => { root.render(createElement(MyDealsSheet, { visible: true, identity: { publicKey: ME }, onClose() {}, initialTab: 'pending' }) as any); });
    for (let i = 0; i < 4; i++) await act(async () => {});
};
const line = () => host.querySelector('[data-testid="deal-not-seen-tx-1"]');

describe('Your deals on the phone: a request that sits unseen', () => {
    for (const dark of [false, true]) {
        it(`${dark ? 'dark' : 'light'}: 4 days, Asha not in our chat since: the days and the other way, named`, async () => {
            theme.dark = dark;
            db.rows = [asked(4 * D)];
            db.cursors = new Map([[ASHA, ago(6 * D)]]);
            await render();
            expect(line()?.textContent).toBe('Not seen in 4 days. You could try Asha another way.');
            expect(db.asked).toEqual([[ASHA]]);
        });
    }

    it('25 hours, our chat never read by her: "Not seen yet."', async () => {
        db.rows = [asked(25 * H)];
        db.cursors = new Map([[ASHA, null]]);
        await render();
        expect(line()?.textContent).toBe('Not seen yet.');
    });

    it('she has been in our chat since the request: nothing', async () => {
        db.rows = [asked(4 * D)];
        db.cursors = new Map([[ASHA, ago(D)]]);
        await render();
        expect(line()).toBeNull();
    });

    it('no chat between us on this phone: no tick to go by, nothing', async () => {
        db.rows = [asked(4 * D)];
        db.cursors = new Map();
        await render();
        expect(line()).toBeNull();
    });

    it('a request on MY listing (mine to answer), or a deal under way: nothing, and no cursor read', async () => {
        db.rows = [asked(4 * D, { buyerPublicKey: ASHA, buyerCallsign: 'Asha', sellerPublicKey: ME, sellerCallsign: 'Me', postAuthorPublicKey: ME })];
        db.cursors = new Map([[ASHA, null]]);
        await render();
        expect(line()).toBeNull();
        act(() => root.unmount());
        root = createRoot(host);
        db.rows = [asked(4 * D, { status: 'pending' })];
        await render();
        expect(line()).toBeNull();
        expect(db.asked).toEqual([]);
    });
});
