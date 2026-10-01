/**
 * App Lock's lock screen, drawn over every surface the app draws on: the root screen, each sheet screen and each pop-up.
 *
 * React Native presents a pop-up (Modal) in its own window: a Dialog on Android, a presented view controller on an
 * iPhone, where the sheet screens (`presentation: 'modal'` in app/_layout.tsx) are presented the same way. Each sits
 * above the root view, so the lock screen drawn there alone sat UNDER whatever was left open: a member who put the phone
 * down with a group, a deal or an event sheet open came back to the return lock's prompt, cancelled it, and the sheet
 * was still on top, readable and tappable (FABLE-sec-native MEDIUM-1, 2026-10-01). And an iPhone can't present a pop-up
 * of its own while one is already presented, so the lock screen can't simply become one.
 *
 * So each surface draws it inside itself ({@link AppLockSurface}): the root layout around the navigator, every sheet
 * screen, and every pop-up, through {@link installLockCovers}, which gives react-native's Modal export a lock screen
 * inside it, as the root layout already does for Text. While it shows, what is under it is hidden from screen readers
 * and takes no touches, and Android's back button closes no pop-up. A pop-up's own state stays as it was, under it.
 *
 * An Alert can't be covered: an iPhone draws it in a window of its own above everything, and nothing can close one. Its
 * buttons do nothing while the lock screen or the cover is up, so an Alert left open behind the lock acts for nobody.
 */
import React, { createElement, type ComponentType, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../app/ThemeContext';
import { appLockScreen, askToUnlockApp, useAppLockScreen } from '../utils/app-lock-screen';

const showsApp = () => appLockScreen() === 'none';

/** The lock screen, or the plain cover, over one surface. */
export function AppLockScreenView({ screen }: { screen: 'cover' | 'lock' }): React.JSX.Element {
    const { theme } = useTheme();
    const isDark = theme === 'dark';
    const background = isDark ? '#0a0a0a' : '#FAF9F6';
    if (screen === 'cover') {
        return <View style={[styles.over, { backgroundColor: background }]} accessibilityViewIsModal testID="app-lock-cover" />;
    }
    return (
        <View style={[styles.over, styles.centred, { backgroundColor: background }]} accessibilityViewIsModal testID="app-lock-screen">
            <View style={{
                backgroundColor: isDark ? '#141414' : '#FFFFFF',
                padding: 32,
                borderRadius: 24,
                alignItems: 'center',
                borderWidth: 1,
                borderColor: isDark ? '#2e2e2e' : '#EBEBE6',
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.1,
                shadowRadius: 12,
                elevation: 5,
                width: '100%',
                maxWidth: 320
            }}>
                <Text style={{ fontSize: 48, marginBottom: 16 }}>🔒</Text>
                <Text style={{
                    fontSize: 22,
                    fontWeight: 'bold',
                    color: isDark ? '#ffffff' : '#1C1D1A',
                    marginBottom: 8,
                    textAlign: 'center'
                }}>
                    BeanPool Secure
                </Text>
                <Text style={{
                    fontSize: 14,
                    color: isDark ? '#a0a0a0' : '#646660',
                    marginBottom: 32,
                    textAlign: 'center',
                    lineHeight: 20
                }}>
                    Unlock with your device security to access your wallet.
                </Text>
                <Pressable
                    style={{
                        backgroundColor: '#10b981',
                        paddingVertical: 14,
                        paddingHorizontal: 28,
                        borderRadius: 12,
                        width: '100%',
                        alignItems: 'center'
                    }}
                    onPress={askToUnlockApp}
                    accessibilityRole="button"
                >
                    <Text style={{ color: '#ffffff', fontSize: 16, fontWeight: 'bold' }}>
                        Unlock App
                    </Text>
                </Pressable>
            </View>
        </View>
    );
}

/**
 * One surface's content, with App Lock's lock screen or cover over it while either shows. The content stays mounted
 * (a half-written sheet is still there after the unlock), in a wrapper that fills the same box its parent gave it, so
 * nothing in it is laid out differently.
 *
 * The wrapper is always a native view of its own (`collapsable={false}`). Without it, Fabric flattens it away while the
 * app shows and makes it a real view while the lock screen or cover shows (pointerEvents and the accessibility props),
 * so every lock or cover change moved each native child, the navigator's ScreenStack included, to a new parent: Android's
 * react-native-screens rebuilt its fragments, and an iPhone's focused field lost its keyboard (deciding review of #1413).
 * Now each change is only a prop update.
 */
export function AppLockSurface({ children }: { children?: ReactNode }): React.JSX.Element {
    const screen = useAppLockScreen();
    const hidden = screen !== 'none';
    return (
        <>
            <View
                style={styles.content}
                collapsable={false}
                pointerEvents={hidden ? 'none' : 'box-none'}
                importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
                accessibilityElementsHidden={hidden}
            >
                {children}
            </View>
            {screen !== 'none' && <AppLockScreenView screen={screen} />}
        </>
    );
}

type ModalLike = ComponentType<{ children?: ReactNode; onRequestClose?: (...args: never[]) => void }>;

/** `Modal`, with App Lock's lock screen inside it, and Android's back button doing nothing while that shows. */
export function lockAwareModal<M extends ModalLike>(Modal: M): M {
    function LockAwareModal(props: { children?: ReactNode; onRequestClose?: (...args: never[]) => void }) {
        const { onRequestClose } = props;
        return createElement(
            Modal,
            {
                ...props,
                onRequestClose: onRequestClose && ((...args: never[]) => {
                    if (showsApp()) onRequestClose(...args);
                }),
            },
            createElement(AppLockSurface, null, props.children),
        );
    }
    // Modal's own statics (its displayName and Context) come along.
    Object.assign(LockAwareModal, Modal, { lockAware: true });
    return LockAwareModal as unknown as M;
}

interface AlertButtonLike {
    onPress?: (value?: string) => void;
}
interface AlertOptionsLike {
    onDismiss?: () => void;
}
type AlertFn = (title: string, message?: string, buttons?: AlertButtonLike[], options?: AlertOptionsLike) => void;

/** `Alert.alert`, whose buttons, and whose dismissal, do nothing while App Lock's lock screen or cover shows. */
export function lockAwareAlert(alert: AlertFn): AlertFn {
    const whileShowing = <A extends unknown[]>(act: ((...args: A) => void) | undefined) =>
        act && ((...args: A) => {
            if (showsApp()) act(...args);
        });
    return (title, message, buttons, options) => alert(
        title,
        message,
        buttons?.map((button) => (button.onPress ? { ...button, onPress: whileShowing(button.onPress) } : button)),
        options?.onDismiss ? { ...options, onDismiss: whileShowing(options.onDismiss) } : options,
    );
}

interface ReactNativeExports {
    Modal: ModalLike;
    Alert: { alert: AlertFn };
}

/**
 * Every pop-up the app opens, through react-native's Modal export, gets the lock screen inside it, and every Alert's
 * buttons wait for the unlock. Run once, by app/_layout.tsx as it loads, before anything draws: like the Text patch
 * there, it relies on each module reading `Modal` off react-native when it draws, which is what the import compiles to.
 */
export function installLockCovers(rn: ReactNativeExports): void {
    const Modal = rn.Modal;
    if ((Modal as unknown as { lockAware?: boolean }).lockAware) return;
    const LockAware = lockAwareModal(Modal);
    Object.defineProperty(rn, 'Modal', {
        configurable: true,
        enumerable: true,
        get() {
            return LockAware;
        },
    });
    rn.Alert.alert = lockAwareAlert(rn.Alert.alert.bind(rn.Alert));
}

const styles = StyleSheet.create({
    content: { flex: 1 },
    over: { ...StyleSheet.absoluteFillObject, zIndex: 99999 },
    centred: { alignItems: 'center', justifyContent: 'center', padding: 24 },
});
