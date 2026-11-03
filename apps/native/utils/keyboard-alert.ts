/**
 * An Alert that closes the keyboard first (3 Nov keyboard audit, group G: scratch/keyboard-audit/AUDIT-2026-11-03.md).
 *
 * A plain `Alert.alert` raised from a screen with a text field leaves the keyboard open behind the dialog: on a small
 * phone the pop-up is half covered, and when it closes the page sits with phantom padding. Screens that can have a field
 * focused import `Alert` from here instead of from react-native; the call sites stay `Alert.alert(...)`.
 *
 * Plain React Native `Keyboard.dismiss()`, never a KeyboardProvider. It can't throw into a handler: a test's react-native
 * mock without a Keyboard just means nobody to dismiss.
 */
import { Alert as NativeAlert, Keyboard } from 'react-native';

export function dismissKeyboardQuietly(): void {
    try {
        Keyboard.dismiss();
    } catch {
        // No keyboard to close (a test mock, a runtime without one): the alert still goes ahead.
    }
}

export const Alert = {
    alert(...args: Parameters<typeof NativeAlert.alert>): void {
        dismissKeyboardQuietly();
        NativeAlert.alert(...args);
    },
};
