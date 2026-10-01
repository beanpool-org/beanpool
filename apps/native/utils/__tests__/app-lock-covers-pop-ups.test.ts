// @vitest-environment jsdom
/**
 * App Lock's lock screen covers every pop-up and sheet left open, not only the screen under them
 * (components/AppLock.tsx, utils/app-lock-screen.ts, app/_layout.tsx).
 *
 * Found by FABLE-sec-native MEDIUM-1, 2026-10-01. React Native presents a pop-up (Modal) in its own window, above the
 * root view: a Dialog on Android, a presented view controller on an iPhone, where the sheet screens are presented the
 * same way. The lock screen was a view in the root layout, so a member who put the phone down with a group, a deal or an
 * event sheet open came back to the return lock, and the sheet stayed on top of the lock screen, readable and tappable.
 *
 * - Each pop-up draws the lock screen inside its own window while App Lock locks, and the cover while the app is out of
 *   the front; what it holds stays mounted under it, hidden from screen readers and from touches.
 * - Android's back button closes no pop-up while the lock screen shows; Unlock App on a pop-up asks the phone's lock.
 * - An Alert can't be covered (an iPhone draws it in a window of its own): its buttons do nothing while locked.
 * - app/_layout.tsx installs this for react-native's Modal before anything draws, and every screen, sheets included,
 *   draws the lock screen inside itself.
 *
 * jsdom and react-dom stand in for the phone: each pop-up is drawn into a window element of its own, as React Native
 * presents it, which says nothing about a phone's frames, only about what each window is asked to draw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('react-native', async () => {
    const { createElement: h } = await import('react');
    type ViewProps = {
        children?: ReactNode;
        testID?: string;
        accessibilityElementsHidden?: boolean;
        importantForAccessibility?: string;
        pointerEvents?: string;
        accessibilityViewIsModal?: boolean;
    };
    return {
        Platform: { OS: 'android' },
        StyleSheet: { create: <T,>(s: T) => s, absoluteFillObject: { position: 'absolute' } },
        View: ({ children, testID, accessibilityElementsHidden, importantForAccessibility, pointerEvents, accessibilityViewIsModal }: ViewProps) =>
            h('div', {
                'data-testid': testID,
                'aria-hidden': accessibilityElementsHidden ? 'true' : undefined,
                'data-important-for-accessibility': importantForAccessibility,
                'data-pointer-events': pointerEvents,
                'aria-modal': accessibilityViewIsModal ? 'true' : undefined,
            }, children),
        Text: ({ children }: { children?: ReactNode }) => h('span', null, children),
        Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) => h('button', { onClick: onPress }, children),
    };
});
vi.mock('../../app/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));

import { AppLockSurface, installLockCovers } from '../../components/AppLock';
import { setAppCovered, setAppLocked, setAppUnlockAction } from '../app-lock-screen';

type ModalProps = { visible?: boolean; children?: ReactNode; onRequestClose?: () => void };

/** React Native's Modal as the app gets it: a window of its own, above the root, drawn while visible. */
const presented = vi.hoisted(() => ({ last: null as null | { onRequestClose?: () => void } }));
function NativeModal(props: ModalProps) {
    presented.last = props;
    return props.visible ? createElement('section', { 'data-window': 'pop-up' }, props.children) : null;
}
NativeModal.displayName = 'Modal';

type AlertButton = { text?: string; onPress?: (value?: string) => void };
type AlertFn = (title: string, message?: string, buttons?: AlertButton[], options?: { onDismiss?: () => void }) => void;

/** react-native's exports object, as app/_layout.tsx requires it: Modal and Alert, before the lock covers go in. */
function reactNative() {
    const alert = vi.fn<AlertFn>();
    return { Modal: NativeModal as unknown as (props: ModalProps) => ReactNode, Alert: { alert: alert as AlertFn }, nativeAlert: alert };
}

let container: HTMLDivElement;
let root: Root;

async function draw(node: ReactNode): Promise<void> {
    await act(async () => { root.render(node as Parameters<Root['render']>[0]); });
}
async function run(change: () => void): Promise<void> {
    await act(async () => { change(); });
}

const popUp = () => container.querySelector('[data-window="pop-up"]');
const lockScreenIn = (el: Element | null) => el?.querySelector('[data-testid="app-lock-screen"]') ?? null;
const coverIn = (el: Element | null) => el?.querySelector('[data-testid="app-lock-cover"]') ?? null;
/** The element that holds what the member wrote, and whether screen readers and touches can reach it. */
const holderOf = (text: string) => Array.from(container.querySelectorAll('[data-pointer-events]')).reverse()
    .find((el) => el.textContent?.includes(text)) ?? null;

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    setAppLocked(false);
    setAppUnlockAction(null);
    presented.last = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
});

describe('a pop-up left open is covered by the lock screen', () => {
    it('the lock screen is drawn inside the pop-up\'s own window, over what it holds, which stays as it was', async () => {
        const rn = reactNative();
        installLockCovers(rn);
        const Modal = rn.Modal;
        await draw(createElement(Modal, { visible: true, onRequestClose: () => {} }, createElement('p', null, "Kim's deal: 40 Beans for the ladder")));
        expect(lockScreenIn(popUp())).toBeNull();

        await run(() => setAppLocked(true));

        expect(lockScreenIn(popUp())).not.toBeNull();
        expect(popUp()?.textContent).toContain('Unlock App');
        // Still there underneath (a half-written sheet survives the unlock), but out of reach.
        const holder = holderOf("Kim's deal");
        expect(holder?.getAttribute('aria-hidden')).toBe('true');
        expect(holder?.getAttribute('data-important-for-accessibility')).toBe('no-hide-descendants');
        expect(holder?.getAttribute('data-pointer-events')).toBe('none');

        await run(() => setAppLocked(false));

        expect(lockScreenIn(popUp())).toBeNull();
        expect(holderOf("Kim's deal")?.getAttribute('aria-hidden')).toBeNull();
        expect(holderOf("Kim's deal")?.getAttribute('data-pointer-events')).toBe('box-none');
    });

    it('the cover too, as the app leaves the front: no Unlock button, nothing of the member\'s', async () => {
        const rn = reactNative();
        installLockCovers(rn);
        await draw(createElement(rn.Modal, { visible: true }, createElement('p', null, 'Robin: see you at the market')));

        await run(() => setAppCovered(true));

        expect(coverIn(popUp())).not.toBeNull();
        expect(lockScreenIn(popUp())).toBeNull();
        expect(holderOf('Robin:')?.getAttribute('aria-hidden')).toBe('true');
    });

    it('a pop-up opened while locked opens under the lock screen too', async () => {
        const rn = reactNative();
        installLockCovers(rn);
        await run(() => setAppLocked(true));

        await draw(createElement(rn.Modal, { visible: true }, createElement('p', null, 'Group: Mullum growers')));

        expect(lockScreenIn(popUp())).not.toBeNull();
    });

    it('Unlock App on a pop-up asks the phone\'s lock, as the one under it does', async () => {
        const rn = reactNative();
        installLockCovers(rn);
        const unlock = vi.fn();
        setAppUnlockAction(unlock);
        await draw(createElement(rn.Modal, { visible: true }, createElement('p', null, 'Event: seed swap')));
        await run(() => setAppLocked(true));

        await run(() => (popUp()?.querySelector('button') as HTMLButtonElement).click());

        expect(unlock).toHaveBeenCalledTimes(1);
    });

    it('Android\'s back button closes no pop-up while the lock screen shows', async () => {
        const rn = reactNative();
        installLockCovers(rn);
        const close = vi.fn();
        await draw(createElement(rn.Modal, { visible: true, onRequestClose: close }, createElement('p', null, 'Deal')));

        await run(() => setAppLocked(true));
        presented.last?.onRequestClose?.();
        expect(close).not.toHaveBeenCalled();

        await run(() => setAppLocked(false));
        presented.last?.onRequestClose?.();
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('installed twice (a reload of the layout), one lock screen per pop-up', async () => {
        const rn = reactNative();
        installLockCovers(rn);
        installLockCovers(rn);
        await draw(createElement(rn.Modal, { visible: true }, createElement('p', null, 'Deal')));
        await run(() => setAppLocked(true));

        expect(popUp()?.querySelectorAll('[data-testid="app-lock-screen"]')).toHaveLength(1);
    });
});

describe('a sheet screen draws the lock screen inside itself', () => {
    it('as patternScreenLayout wraps it: the lock screen inside the sheet, over the chat', async () => {
        await draw(createElement('section', { 'data-window': 'pop-up' },
            createElement(AppLockSurface, null, createElement('p', null, 'Chat with Robin'))));

        await run(() => setAppLocked(true));

        expect(lockScreenIn(popUp())).not.toBeNull();
        expect(holderOf('Chat with Robin')?.getAttribute('aria-hidden')).toBe('true');
    });
});

describe("an Alert left open can't be covered, so its buttons wait for the unlock", () => {
    it('a button tapped while locked does nothing; after the unlock it acts', async () => {
        const rn = reactNative();
        installLockCovers(rn);
        const pay = vi.fn();
        rn.Alert.alert('Pay Kim?', '40 Beans', [{ text: 'Cancel' }, { text: 'Pay', onPress: pay }]);
        const [, , buttons] = rn.nativeAlert.mock.calls[0];
        const payButton = buttons!.find((b) => b.text === 'Pay')!;

        setAppLocked(true);
        payButton.onPress!();
        expect(pay).not.toHaveBeenCalled();

        setAppLocked(false);
        payButton.onPress!();
        expect(pay).toHaveBeenCalledTimes(1);
    });

    it('nor while the cover is up, and a dismissal waits the same way', async () => {
        const rn = reactNative();
        installLockCovers(rn);
        const dismissed = vi.fn();
        const act1 = vi.fn();
        rn.Alert.alert('Is this you?', undefined, [{ text: 'Review', onPress: act1 }], { onDismiss: dismissed });
        const [, , buttons, options] = rn.nativeAlert.mock.calls[0];

        setAppCovered(true);
        buttons![0].onPress!();
        options!.onDismiss!();
        expect(act1).not.toHaveBeenCalled();
        expect(dismissed).not.toHaveBeenCalled();
        setAppCovered(false);
    });
});

describe('app/_layout.tsx', () => {
    const layout = () => fs.readFileSync(path.resolve(__dirname, '../../app/_layout.tsx'), 'utf-8');

    it('installs the lock covers on react-native as it loads, before any screen draws', () => {
        const s = layout();
        const installed = s.indexOf('\ninstallLockCovers(RN);');
        expect(installed).toBeGreaterThan(-1);
        expect(installed).toBeLessThan(s.indexOf('function RootLayoutNav('));
    });

    it('every screen, sheets included, draws the lock screen inside itself, and the navigator has it over it', () => {
        const s = layout();
        const screenLayout = s.slice(s.indexOf('function patternScreenLayout('), s.indexOf('function RootLayoutNav('));
        expect(screenLayout).toContain("if (options.presentation && options.presentation !== 'card') return <AppLockSurface>{children}</AppLockSurface>;");
        expect(screenLayout.match(/<AppLockSurface>/g)).toHaveLength(2);
        expect(s).toMatch(/<AppLockSurface>\s*<NavThemeProvider value=\{navTheme\}>/);
        // The forged-notice line (components/PushNoticeWarning.tsx) sits inside the same surface, so the lock covers it too.
        expect(s).toMatch(/<\/NavThemeProvider>\s*(\{\/\*[\s\S]*?\*\/\}\s*)?<PushNoticeWarning \/>\s*<\/AppLockSurface>/);
        // The lock screen is no longer a view of the root layout's own, which every pop-up sat above.
        expect(s).not.toContain('isLocked && identity &&');
    });
});
