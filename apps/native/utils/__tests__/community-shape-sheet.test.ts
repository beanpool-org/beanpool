// @vitest-environment jsdom
/**
 * Tests for the members' community shape sheet and Home summary line (design §4, slice S5).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
    const Loader = (process as any).getBuiltinModule?.('node:module');
    if (Loader?._extensions) {
        Loader._extensions['.jpg'] = (m: { exports: unknown }) => { m.exports = 1; };
        Loader._extensions['.webp'] = (m: { exports: unknown }) => { m.exports = 1; };
        Loader._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
    }
    (globalThis as any).expo = (globalThis as any).expo ?? {
        EventEmitter: class EventEmitter {
            addListener() { return { remove() {} }; }
            removeListener() {}
            emit() {}
        },
        modules: {},
    };
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { darkColors, lightColors } from '../../constants/colors';
import { CommunityShapeSheet } from '../../components/CommunityShapeSheet';
import { CommunityBody } from '../../components/home/HomeCardBodies';
import type { CommunityShapeFeatures } from '@beanpool/core';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, numberOfLines } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = () => onPress({ stopPropagation() {} });
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        attrs['data-style'] = JSON.stringify(Object.assign({}, ...[props.style].flat(3).filter(s => s && typeof s === 'object')));
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        View: el('div'),
        Text: el('span'),
        Pressable: el('button'),
        ScrollView: el('div'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
    };
});

const routes = vi.hoisted(() => ({ pushed: [] as unknown[] }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((len: number) => new Uint8Array(len)) }));
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
vi.mock('expo-router', () => ({
    router: {
        push: (to: unknown) => routes.pushed.push(to),
        navigate: (to: unknown) => routes.pushed.push(to),
    },
}));

const theme = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors: light, darkColors: dark } = await import('../../constants/colors');
    const colors = () => (theme.dark ? dark : light);
    return {
        useTheme: () => ({ theme: theme.dark ? 'dark' : 'light', colors: colors() }),
    };
});

describe('CommunityShapeSheet and Home summary (S5)', () => {
    let host: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        routes.pushed = [];
        theme.dark = false;
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
    });

    afterEach(() => {
        root.unmount();
        host.remove();
    });

    const render = async (element: React.ReactElement) => {
        await act(async () => {
            root.render(element as any);
        });
    };

    const FULL_FEATURES: CommunityShapeFeatures = {
        door: 'members',
        knocks: true,
        privatePreview: true,
        beans: true,
        knownFloor: 1000,
        dmRequests: true,
        decisions: true,
        probation: true,
        autoHideReports: true,
        autoMute: true,
    };

    it('renders the sheet with all lines, header, and read more button in light theme', async () => {
        theme.dark = false;
        const onClose = vi.fn();
        await render(createElement(CommunityShapeSheet, {
            features: FULL_FEATURES,
            visible: true,
            onClose,
        }));

        const sheet = host.querySelector('[data-testid="community-shape-sheet"]');
        expect(sheet).not.toBeNull();
        expect(sheet?.textContent).toContain('How this community works');
        expect(sheet?.textContent).toContain('any member can invite someone');
        expect(sheet?.textContent).toContain('Private preview:');
        expect(sheet?.textContent).toContain('Beans: on');
        expect(sheet?.textContent).toContain('Confirmed members can owe up to 1,000 Beans (the known floor)');
        expect(sheet?.textContent).toContain('Messages: a first message from someone new waits');
        expect(sheet?.textContent).toContain('Decisions: members vote');
        expect(sheet?.textContent).toContain('New accounts: limits for their first days');
        expect(sheet?.textContent).toContain('Reported posts are hidden until a moderator looks');
        expect(sheet?.textContent).toContain('Repeat offenders are muted automatically');
        expect(sheet?.textContent).toContain('Read more in the guide');

        const readMore = host.querySelector('[data-testid="community-shape-read-more"]') as HTMLButtonElement;
        expect(readMore).not.toBeNull();
        await act(async () => {
            readMore.click();
        });
        expect(onClose).toHaveBeenCalled();
        expect(routes.pushed).toEqual([{ pathname: '/guide/[slug]', params: { slug: 'how-your-community-works' } }]);
    });

    it('renders in dark theme cleanly without error', async () => {
        theme.dark = true;
        const onClose = vi.fn();
        await render(createElement(CommunityShapeSheet, {
            features: FULL_FEATURES,
            visible: true,
            onClose,
        }));
        const sheet = host.querySelector('[data-testid="community-shape-sheet"]');
        expect(sheet).not.toBeNull();
    });

    it('handles an old node that says nothing (produces empty facts list)', async () => {
        await render(createElement(CommunityShapeSheet, {
            features: {},
            visible: true,
            onClose: vi.fn(),
        }));
        const sheet = host.querySelector('[data-testid="community-shape-sheet"]');
        expect(sheet).not.toBeNull();
        expect(sheet?.textContent).toContain('How this community works');
        expect(sheet?.textContent).toContain('Read more in the guide');
        expect(sheet?.textContent).not.toContain('Joining:');
        expect(sheet?.textContent).not.toContain('Beans:');
    });

    it('CommunityBody renders shape summary row with chevron and handles tap', async () => {
        const onOpenShape = vi.fn();
        await render(createElement(CommunityBody, {
            card: {
                name: 'Riverside Commons',
                members: 15,
                joined7d: 2,
                tradesThisMonth: 5,
                commonsPot: 500,
                listings: 10,
                eventsSoon: 1,
            },
            profile: 'local',
            invitesOn: true,
            features: {
                beans: true,
                knocks: true,
                decisions: true,
                invites: true,
                door: 'members',
            },
            colors: lightColors,
            onOpenShape,
        }));

        const summaryRow = host.querySelector('[data-testid="home-community-shape-summary"]');
        expect(summaryRow).not.toBeNull();
        expect(summaryRow?.textContent).toContain('How it works: any member invites · Beans on · votes on · requests to join on ›');

        await act(async () => {
            (summaryRow as HTMLElement).click();
        });
        expect(onOpenShape).toHaveBeenCalled();
    });

    it('CommunityBody does NOT render summary row for an old node that says nothing', async () => {
        await render(createElement(CommunityBody, {
            card: {
                name: 'Riverside Commons',
                members: 15,
                joined7d: 2,
                tradesThisMonth: 5,
                commonsPot: 500,
                listings: 10,
                eventsSoon: 1,
            },
            profile: 'local',
            invitesOn: true,
            features: {}, // old node without shape
            colors: lightColors,
        }));

        const summaryRow = host.querySelector('[data-testid="home-community-shape-summary"]');
        expect(summaryRow).toBeNull();
    });
});
