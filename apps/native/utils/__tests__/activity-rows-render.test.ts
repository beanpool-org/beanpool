// @vitest-environment jsdom
/**
 * The phone's Community Pulse list (Marty, 30 Oct: "we need it clickable"): components/ActivityWaterfall rendered for real.
 * Every row with somewhere to go is one real button (accessible name = its sentence, at least 44 dp) that opens it by the rule
 * the web uses (core's activityTarget); a row with nothing to open stays plain text. React Native's host components are plain
 * tags carrying their accessibility props, as in market-words-render.test.ts; the node is a stand-in for utils/db.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessible } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress) attrs.onClick = () => onPress({ stopPropagation() {} });
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (accessible) attrs['data-accessible'] = 'true';
        // A Pressable's style may be a function of its pressed state, as in React Native.
        const s = flat(typeof props.style === 'function' ? props.style({ pressed: false }) : props.style);
        if (typeof s.minHeight === 'number') attrs['data-min-height'] = String(s.minHeight);
        return createElement(tag, attrs, children);
    };
    return {
        View: el('div'), Text: el('span'), Pressable: el('button'), ActivityIndicator: () => null,
        StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => flat(s) },
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    };
});
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => 'https://node.test') } }));
const feed = vi.hoisted(() => ({ items: [] as any[] }));
vi.mock('../db', () => ({ signedGet: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ feed: feed.items }) })) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return { useTheme: () => ({ theme: 'light', colors: lightColors }) };
});

import { ActivityWaterfall } from '../../components/ActivityWaterfall';

const now = new Date().toISOString();
const items = {
    joined: { id: 10, eventType: 'member_joined', actorPubkey: 'pk-bob', actorCallsign: 'Bob', metadata: {}, createdAt: now },
    posted: { id: 11, eventType: 'post_created', actorPubkey: 'pk-damo', actorCallsign: 'Damo', metadata: { postId: 'post-1', title: 'Record Fair' }, createdAt: now },
    tradedNoListing: {
        id: 13, eventType: 'trade_completed', actorPubkey: 'pk-sam', actorCallsign: 'Sam', targetPubkey: 'pk-bea', targetCallsign: 'Bea',
        metadata: { credits: 12 }, createdAt: now,
    },
    rated: {
        id: 14, eventType: 'rating_given', actorPubkey: 'pk-rae', actorCallsign: 'Rae', targetPubkey: 'pk-tia', targetCallsign: 'Tia',
        metadata: { stars: 3 }, createdAt: now,
    },
    postedNoId: { id: 15, eventType: 'post_created', actorPubkey: 'pk-damo', actorCallsign: 'Damo', metadata: { title: 'Old listing' }, createdAt: now },
};

let host: HTMLElement;
let root: Root;
const onOpenPost = vi.fn();
const onOpenProfile = vi.fn();

async function show(props: Record<string, unknown> = { onOpenPost, onOpenProfile }) {
    await act(async () => { root.render(createElement(ActivityWaterfall as any, props)); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const buttons = () => Array.from(host.querySelectorAll<HTMLElement>('button, [role="button"]'));
const rowNamed = (re: RegExp) => buttons().find((b) => re.test(b.getAttribute('aria-label') ?? ''))!;
const click = (el: HTMLElement) => act(async () => { el.click(); });

beforeEach(() => {
    onOpenPost.mockClear();
    onOpenProfile.mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('the phone\'s Community Pulse rows open what they are about', () => {
    it('a post row opens that post; its name is the row\'s sentence', async () => {
        feed.items = [items.posted];
        await show();
        const row = rowNamed(/Damo posted "Record Fair"/);
        expect(row).toBeTruthy();
        await click(row);
        expect(onOpenPost).toHaveBeenCalledWith('post-1');
        expect(onOpenProfile).not.toHaveBeenCalled();
    });

    it('a joined row opens the member\'s profile, with their name for the header', async () => {
        feed.items = [items.joined];
        await show();
        await click(rowNamed(/Bob joined the community/));
        expect(onOpenProfile).toHaveBeenCalledWith('pk-bob', 'Bob');
        expect(onOpenPost).not.toHaveBeenCalled();
    });

    it('a trade with no listing opens the other member, named as the other member', async () => {
        feed.items = [items.tradedNoListing];
        await show();
        await click(rowNamed(/Sam traded with Bea/));
        expect(onOpenProfile).toHaveBeenCalledWith('pk-bea', 'Bea');
    });

    it('a rating opens the rated member', async () => {
        feed.items = [items.rated];
        await show();
        await click(rowNamed(/Rae rated Tia/));
        expect(onOpenProfile).toHaveBeenCalledWith('pk-tia', 'Tia');
    });

    it('a rating the viewer received opens the rater, named as the rater', async () => {
        feed.items = [items.rated];
        await show({ onOpenPost, onOpenProfile, viewerPubkey: 'pk-tia' });
        await click(rowNamed(/Rae rated Tia/));
        expect(onOpenProfile).toHaveBeenCalledWith('pk-rae', 'Rae');
    });

    it('a row with no target is not a button', async () => {
        feed.items = [items.postedNoId];
        await show();
        expect(host.textContent).toContain('Old listing');
        expect(buttons()).toHaveLength(0);
    });

    it('every row that opens is at least 44 dp tall', async () => {
        feed.items = [items.joined, items.posted, items.rated];
        await show();
        expect(buttons()).toHaveLength(3);
        for (const b of buttons()) expect(Number(b.getAttribute('data-min-height'))).toBeGreaterThanOrEqual(44);
    });

    it('with no openers handed in, no row pretends to be a control', async () => {
        feed.items = [items.joined, items.posted];
        await show({});
        expect(host.textContent).toContain('Bob');
        expect(buttons()).toHaveLength(0);
    });
});
