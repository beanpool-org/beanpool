// @vitest-environment jsdom
/**
 * The phone's deadline badges beside its pledge gate (#2500, its deciding review): components/EnterpriseCard.tsx, the
 * Commons card, and components/YoursEnterpriseRow.tsx, a project in Yours, rendered for real with the clock held still,
 * for a deadline at a range of times either side of its day's edge. Each badge says what it always said ("{n} days left",
 * "Ends today", "Expired"), and says "Expired" exactly when the node refuses a pledge (core's isPastDeadline): the card
 * shows its Pledge Beans line until then. A pledge gate that closed while the badge said "Ends today" was the finding.
 *
 * React Native's host components are plain tags (the harness of commons-enterprises-render.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, accessibilityLabel, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), Image: el('img'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => s },
    };
});
vi.mock('expo-router', () => ({ router: { push() {}, navigate() {}, replace() {}, back() {} } }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown; patternEnabled: boolean }) => unknown) => make({ theme: 'light', colors: lightColors, patternEnabled: false }),
    };
});
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
vi.mock('../../components/showcase/LocalCommunityMark', () => ({ LocalCommunityMark: () => null }));

import { isPastDeadline, setLanguage } from '@beanpool/core';
import { EnterpriseCard } from '../../components/EnterpriseCard';
import { YoursEnterpriseRow } from '../../components/YoursEnterpriseRow';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-26T09:30:00.000Z');
const KEY = '7'.repeat(64);

/** An active project short of its goal, whose deadline's instant was `before` ms before now. */
const project = (before: number) => ({
    publicKey: KEY, name: 'Village Well', callsign: 'Village Well', purpose: 'Clean water', balance: 5, creditLine: 0, liveOffers: 0,
    goalAmount: 20, currentAmount: 5, lifecycle: 'bounded', status: 'active', paused: false, keepers: [],
    deadlineAt: new Date(NOW - before).toISOString(),
});
const CHAT = {
    kind: 'enterprise' as const, lifecycle: 'bounded' as const, badge: null, id: KEY, conversationId: KEY, name: 'Village Well',
    avatarUrl: null, role: 'lead', readOnly: false, lastMessage: null, unreadCount: 0, mute: null, lastActivityAt: new Date(NOW).toISOString(),
};

/** [when the deadline's instant was, ms before now, what the badge has always said then]. */
const ROWS: Array<[string, number, string]> = [
    ['3 days ahead', -3 * DAY, '3 days left'],
    ['an hour ahead', -HOUR, '1 days left'],
    ['at the deadline', 0, 'Ends today'],
    ['an hour after', HOUR, 'Ends today'],
    ['23 h 59 m after', DAY - MINUTE, 'Ends today'],
    ['a millisecond short of 24 h after', DAY - 1, 'Ends today'],
    ['24 h after', DAY, 'Expired'],
    ['25 h after', DAY + HOUR, 'Expired'],
    ['3 days after', 3 * DAY, 'Expired'],
];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    setLanguage('en');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
});

const draw = (element: unknown) => act(() => { root.render(element as any); });

describe('The Commons card: its badge, and Pledge Beans until the badge says Expired', () => {
    it.each(ROWS)('%s', (_when, before, badge) => {
        const item = project(before);
        draw(createElement(EnterpriseCard, { item } as any));
        const text = host.textContent ?? '';
        expect(text).toContain(`⏳ ${badge}`);
        const expired = badge === 'Expired';
        expect(isPastDeadline(item.deadlineAt)).toBe(expired);
        expect(text.includes('Pledge Beans')).toBe(!expired);
    });
});

describe('A project in Yours: its line says what the badge always said', () => {
    it.each(ROWS)('%s', (_when, before, badge) => {
        const summary = project(before);
        draw(createElement(YoursEnterpriseRow, { item: { chat: CHAT, summary } } as any));
        expect(host.textContent).toContain(`5 of 20 🫘 raised · ${badge}`);
        expect(isPastDeadline(summary.deadlineAt)).toBe(badge === 'Expired');
    });
});
