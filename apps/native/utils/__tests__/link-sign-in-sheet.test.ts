// @vitest-environment jsdom
/**
 * "Add a sign-in as a second way back" (components/LinkSignInSheet.tsx), rendered for real (react-dom in jsdom, React
 * Native's host components as plain tags, the Modal's `onRequestClose` as Android's Back).
 *
 * PR #1452 deciding review, finding 5: Android Back on "✅ Sign-in added" called only `onClose`, so Safety Backup kept
 * the 12-words-only panel and offered the sign-in again. Back at `done` is the Done button's path: `onLinked`, then
 * `onClose`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const modal = vi.hoisted(() => ({ requestClose: null as null | (() => void) }));
vi.mock('react-native', () => {
    const el = (tag: string) => ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
        createElement(tag, onPress ? { onClick: onPress } : null, children);
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), TouchableOpacity: el('button'), ActivityIndicator: el('i'), ScrollView: el('div'),
        StyleSheet: { create: (s: unknown) => s },
        // Android's Back on a Modal calls its onRequestClose: kept here so the test can press it.
        Modal: ({ children, visible, onRequestClose }: { children?: ReactNode; visible: boolean; onRequestClose: () => void }) => {
            modal.requestClose = onRequestClose;
            return visible ? createElement('section', null, children) : null;
        },
    };
});
vi.mock('../../components/SsoButton', () => {
    const button = ({ title, onPress }: { title: string; onPress: () => void }) => createElement('button', { onClick: onPress }, title);
    return { GoogleButton: button, AppleButton: button, FacebookButton: button };
});
vi.mock('../sso-signin', () => ({
    SsoSignInError: class extends Error { constructor(public reason: string, message: string) { super(message); } },
    returnToApp: vi.fn(async () => undefined),
}));
vi.mock('../sso-providers', () => ({ SSO_PROVIDER_NAMES: { google: 'Google', apple: 'Apple', facebook: 'Facebook' } }));
vi.mock('../LocalAuth', () => ({ authenticateUser: vi.fn(async () => true) }));
const linked = { kind: 'linked', provider: 'google', enrolment: null } as const;
vi.mock('../join-link', () => ({
    linkSignIn: vi.fn(async () => linked),
    linkedNotice: () => 'Your Google sign-in is added.',
}));
vi.mock('../one-way-back', () => ({ finishOneWayBack: vi.fn(async () => undefined) }));

import { LinkSignInSheet } from '../../components/LinkSignInSheet';

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});

function buttonNamed(text: string): HTMLButtonElement {
    const found = Array.from(document.querySelectorAll('button')).find(b => b.textContent === text);
    if (!found) throw new Error(`no button "${text}" in: ${document.body.textContent}`);
    return found as HTMLButtonElement;
}

async function addedSheet() {
    const onLinked = vi.fn();
    const onClose = vi.fn();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const identity = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(64), callsign: 'Ana' };
    act(() => {
        root!.render(createElement(LinkSignInSheet, { visible: true, onClose, onLinked, identity: identity as any, url: 'https://global.test', askPhoneLock: false }) as unknown as Parameters<Root['render']>[0]);
    });
    await act(async () => { buttonNamed('Continue with Google').click(); });
    expect(document.body.textContent).toContain('✅ Sign-in added');
    return { onLinked, onClose };
}

describe('the sign-in sheet at "✅ Sign-in added"', () => {
    it('Android Back is the Done button\'s path: onLinked with the answer, then onClose', async () => {
        const { onLinked, onClose } = await addedSheet();
        act(() => { modal.requestClose!(); });
        expect(onLinked).toHaveBeenCalledWith(linked);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('control: the Done button does the same', async () => {
        const { onLinked, onClose } = await addedSheet();
        act(() => { buttonNamed('Done').click(); });
        expect(onLinked).toHaveBeenCalledWith(linked);
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
