/**
 * The page the app opened in its in-app browser, closed as App Lock's lock screen goes up (app/_layout.tsx).
 *
 * "Manage <community>" (components/useManageNode.tsx) opens the community's node Settings in expo-web-browser, signed in
 * through the phone's hand-off. On an iPhone that is an SFSafariViewController presented above the app's root view and
 * above every pop-up and sheet, so the lock screen, drawn inside the app (components/AppLock.tsx), sat UNDER it: a member
 * who cancelled the Face ID prompt was in the admin console (deciding review of #1413, 2026-10-01). Closing it is the
 * only way to cover it. Settings keeps its own session; the member opens Manage again after unlocking.
 *
 * Only as the lock screen goes up, never for the plain cover: a short switch away shows the cover and must not close a
 * page the member is still using.
 *
 * Android has nothing to call: `dismissBrowser` is iOS-only (it resolves to undefined there, so `.catch` on it would
 * throw). The Custom Tab opens as a task of its own, outside BeanPool, and BeanPool's lock can't be drawn over it; the
 * node's Settings locks itself after a short idle instead (apps/server/src/admin-key-auth.ts PHONE_HANDOFF_IDLE_TTL_MS),
 * and the guide tells members to close such pages before putting the phone down.
 */
import { Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';

export function closeInAppBrowserForLock(): void {
    if (Platform.OS !== 'ios') return;
    try {
        const closing = WebBrowser.dismissBrowser() as Promise<unknown> | undefined;
        closing?.catch(() => {});
    } catch {
        // Nothing open, or no native module: nothing to close.
    }
}
