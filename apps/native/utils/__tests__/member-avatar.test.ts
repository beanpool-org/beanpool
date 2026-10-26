// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Module from 'node:module';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
vi.hoisted(() => {
    const Loader = (process as any).getBuiltinModule('node:module');
    Loader._extensions['.jpg'] = (m: { exports: unknown }) => { m.exports = 1; };
    Loader._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
});

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo', () => ({
    requireNativeModule: vi.fn(() => ({})),
    requireOptionalNativeModule: vi.fn(() => null),
}));
vi.mock('expo-modules-core', () => ({
    requireNativeModule: vi.fn(() => ({})),
    requireOptionalNativeModule: vi.fn(() => null),
    EventEmitter: vi.fn(() => ({ addListener: vi.fn(), removeListener: vi.fn() })),
    NativeModulesProxy: {},
    ProxyNativeModule: {},
}));

vi.mock('react-native', () => {
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, accessibilityLabel, style, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        attrs['data-style'] = JSON.stringify(style);
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'),
        Text: el('span'),
        Pressable: el('button'),
        Dimensions: { get: () => ({ width: 320, height: 569 }) },
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
        Modal: ({ visible, children }: any) => (visible ? createElement('div', { 'data-modal': 'true' }, children) : null),
    };
});

vi.mock('expo-image', () => {
    return {
        Image: (props: any) => createElement('img', {
            src: typeof props.source === 'object' && props.source?.uri ? props.source.uri : String(props.source),
            'data-source': JSON.stringify(props.source),
            'aria-label': props.accessibilityLabel,
            alt: props.accessibilityLabel || '',
        }),
    };
});

vi.mock('../node-post', () => ({
    anchorUrl: vi.fn(async () => 'https://node.example'),
    getCachedAnchorUrl: vi.fn(() => 'https://node.example'),
}));

import { MemberAvatar } from '../../components/MemberAvatar';

describe('MemberAvatar (native) — no bare initials (Marty addition)', () => {
    let host: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
    });

    afterEach(async () => {
        await act(async () => { root.unmount(); });
        host.remove();
    });

    it('renders a deterministic ready-made preset and NO bare initial letter disc for a pictureless member', async () => {
        const pubkey = 'c'.repeat(64);
        await act(async () => {
            root.render(createElement(MemberAvatar, {
                avatarUrl: null,
                pubkey,
                callsign: 'Charlie',
                size: 40,
            }));
        });

        // Must NOT render bare initial 'C'
        expect(host.textContent).not.toBe('C');
        expect(host.textContent).toBe('');

        // Must render an img element (the ready-made preset)
        const img = host.querySelector('img');
        expect(img).not.toBeNull();
        expect(img?.getAttribute('aria-label')).toBe("Charlie's avatar");
    });

    it('gives the same deterministic preset for the same pubkey across renders', async () => {
        const pubkey = 'd'.repeat(64);
        await act(async () => {
            root.render(createElement(MemberAvatar, {
                avatarUrl: null,
                pubkey,
                callsign: 'Dana',
                size: 40,
            }));
        });

        const img1 = host.querySelector('img')?.getAttribute('data-source');

        await act(async () => {
            root.render(createElement(MemberAvatar, {
                avatarUrl: null,
                pubkey,
                callsign: 'Dana',
                size: 40,
            }));
        });

        const img2 = host.querySelector('img')?.getAttribute('data-source');
        expect(img1).toBeTruthy();
        expect(img1).toBe(img2);
    });
});
