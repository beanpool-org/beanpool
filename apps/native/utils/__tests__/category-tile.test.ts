// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, testID, style } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        return createElement(tag, { ...attrs, 'data-style': JSON.stringify(style) }, children);
    };
    return {
        Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios ?? o.default },
        View: el('div'),
        Text: el('span'),
        StyleSheet: {
            create: (s: Record<string, any>) => s,
        },
    };
});

vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn(async () => undefined) }));
vi.mock('expo-navigation-bar', () => ({ setStyle: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async () => null,
        setItem: async () => {},
        removeItem: async () => {},
    },
}));

import { CategoryTile } from '../../components/CategoryTile';

describe('CategoryTile (Native)', () => {
    function renderComponent(ui: React.ReactElement) {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        act(() => {
            root.render(ui as any);
        });
        return {
            container,
            unmount: () => {
                act(() => root.unmount());
                container.remove();
            },
        };
    }

    it('renders cleanly outside ThemeProvider without crashing (rules of hooks check)', () => {
        const { container, unmount } = renderComponent(
            createElement(CategoryTile, { category: 'food' })
        );
        expect(container.textContent).toContain('🥕');
        expect(container.textContent).toContain('FOOD');
        unmount();
    });

    it('renders unknown category with package emoji 📦 and GENERAL', () => {
        const { container, unmount } = renderComponent(
            createElement(CategoryTile, { category: 'unknown_xyz' })
        );
        expect(container.textContent).toContain('📦');
        expect(container.textContent).toContain('GENERAL');
        unmount();
    });

    it('renders null category with package emoji 📦 and GENERAL', () => {
        const { container, unmount } = renderComponent(
            createElement(CategoryTile, { category: null })
        );
        expect(container.textContent).toContain('📦');
        expect(container.textContent).toContain('GENERAL');
        unmount();
    });

    it('renders known general category with seedling emoji 🌱', () => {
        const { container, unmount } = renderComponent(
            createElement(CategoryTile, { category: 'general' })
        );
        expect(container.textContent).toContain('🌱');
        expect(container.textContent).toContain('GENERAL');
        unmount();
    });

    it('renders event kind with calendar emoji 📅 and EVENT label', () => {
        const { container, unmount } = renderComponent(
            createElement(CategoryTile, { kind: 'event' })
        );
        expect(container.textContent).toContain('📅');
        expect(container.textContent).toContain('EVENT');
        unmount();
    });

    it('renders pulse kind with newspaper emoji 🗞️ and PULSE label', () => {
        const { container, unmount } = renderComponent(
            createElement(CategoryTile, { kind: 'pulse' })
        );
        expect(container.textContent).toContain('🗞️');
        expect(container.textContent).toContain('PULSE');
        unmount();
    });
});
