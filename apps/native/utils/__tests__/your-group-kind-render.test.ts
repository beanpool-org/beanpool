// @vitest-environment jsdom
/**
 * "Your groups" rows (components/YourGroupRow.tsx) and the chat header (components/ChatOwnerHeader.tsx) rendered for
 * real: react-dom in jsdom, React Native's host components as plain tags carrying their accessibility label.
 *
 * Group decisions §3.1: a project is a project (🎯, Leader / Collaborator), an enterprise an enterprise (🥖, keeper
 * words), from the `lifecycle` the node sends on each enterprise-kind row; a node too old to send it reads enterprise.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { YourChat } from '../your-groups';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const attrs: Record<string, unknown> = {};
        if (props.accessibilityLabel) attrs['aria-label'] = props.accessibilityLabel;
        if (props.onPress && !props.disabled) attrs.onClick = () => props.onPress();
        return createElement(tag, attrs, props.children);
    };
    return {
        View: el('div'), Text: el('span'), Pressable: el('button'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
    };
});
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { theme: 'light', colors: lightColors };
    return { useTheme: () => ctx, useStyles: (make: (c: typeof ctx) => unknown) => make(ctx) };
});

import { YourGroupRow } from '../../components/YourGroupRow';
import { ChatOwnerHeader } from '../../components/ChatOwnerHeader';

const row = (over: Partial<YourChat>): YourChat => ({
    kind: 'enterprise', badge: '🥖', id: 'x', conversationId: 'x', name: 'Hall roof', avatarUrl: null, role: 'keeper',
    readOnly: false, lastMessage: null, unreadCount: 0, mute: null, lastActivityAt: '2026-10-13T00:00:00.000Z', ...over,
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
});
const draw = (node: ReturnType<typeof createElement>) => act(() => root.render(node as unknown as Parameters<Root['render']>[0]));
const label = () => container.querySelector('button')?.getAttribute('aria-label') ?? '';

describe('Your groups names a project a project (§3.1)', () => {
    it('a project row: 🎯, "Project", and its leader or collaborator in the spoken label', () => {
        draw(createElement(YourGroupRow, { item: row({ lifecycle: 'bounded', badge: '🎯', role: 'lead' }), onPress: () => { } }));
        expect(container.textContent).toContain('🎯');
        expect(container.textContent).toContain('Project');
        expect(container.textContent).not.toMatch(/enterprise|🥖/i);
        expect(label()).toMatch(/^Hall roof, project, leader\b/);
        draw(createElement(YourGroupRow, { item: row({ lifecycle: 'bounded', badge: '🎯', role: 'keeper' }), onPress: () => { } }));
        expect(label()).toMatch(/^Hall roof, project, collaborator\b/);
        expect(label()).not.toMatch(/keeper|enterprise/i);
    });

    it('an enterprise row keeps 🥖, "Enterprise" and keeper words; so does a row from a node too old to say', () => {
        for (const lifecycle of ['ongoing', undefined] as const) {
            draw(createElement(YourGroupRow, { item: row({ name: 'Bakery', lifecycle, role: 'lead' }), onPress: () => { } }));
            expect(container.textContent).toContain('🥖');
            expect(container.textContent).toContain('Enterprise');
            expect(container.textContent).not.toContain('🎯');
            expect(label()).toMatch(/^Bakery, enterprise, lead keeper\b/);
        }
    });

    it('the chat header: "🎯 Hall roof" over "project"; an enterprise\'s over "enterprise"', () => {
        draw(createElement(ChatOwnerHeader, { kind: 'enterprise', name: 'Hall roof', lifecycle: 'bounded', onBack: () => { }, onOpenOwner: () => { } }));
        expect(container.textContent).toContain('🎯 Hall roof');
        expect(container.textContent).toMatch(/project\s+·\s+tap for info/);
        expect(container.textContent).not.toMatch(/enterprise/i);
        draw(createElement(ChatOwnerHeader, { kind: 'enterprise', name: 'Bakery', onBack: () => { }, onOpenOwner: () => { } }));
        expect(container.textContent).toContain('🥖 Bakery');
        expect(container.textContent).toMatch(/enterprise\s+·\s+tap for info/);
    });
});
