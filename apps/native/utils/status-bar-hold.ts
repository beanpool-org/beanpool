/**
 * The status bar's icons for something drawn above every screen (the full-screen "Update required",
 * components/ForceUpdateBlock.tsx), held while it is up and given back when it comes down.
 *
 * Every screen sets its icons with expo-status-bar's StatusBar, which is React Native's: a stack of entries in mount
 * order, the newest winning. An entry for the block, pushed when it goes up, lost to any screen's StatusBar mounted
 * beneath it afterwards: Welcome mounts a new one with every step it moves to (seen on the emulator at 320dp and 1.3x,
 * #1443: dark icons over the block's dark page). So while the hold is on, every later push is followed by this entry
 * moving back to the top, through React Native's own public calls (pushStackEntry, popStackEntry), and releasing it pops
 * the entry and leaves the stack to the screens again, whose newest entry then sets the bar.
 *
 * The style is also asked of the phone outright as the hold starts: the stack calls the phone only when its own idea of
 * the style changes, and a write it did not make (the development build's launcher writes the bar as the app loads)
 * would otherwise stand while the stack believed the icons right.
 */
import { StatusBar } from 'react-native';

export type HeldBarStyle = 'light-content' | 'dark-content';

type Entry = ReturnType<typeof StatusBar.pushStackEntry>;

let held: { barStyle: HeldBarStyle; entry: Entry; push: typeof StatusBar.pushStackEntry } | null = null;

/**
 * Holds the status bar's icons at `barStyle` ('light-content': light icons; 'dark-content': dark icons) until the
 * returned release is called. A second hold replaces the first (there is one block). Never throws: a phone or build
 * where the status bar can't be set keeps whatever it had.
 */
export function holdStatusBarStyle(barStyle: HeldBarStyle): () => void {
    releaseHeld();
    try {
        const push = StatusBar.pushStackEntry;
        const mine = { barStyle: barStyle, animated: false };
        const hold = { barStyle, entry: push.call(StatusBar, mine), push };
        held = hold;
        StatusBar.pushStackEntry = function pushThenStayOnTop(props) {
            const theirs = push.call(StatusBar, props);
            if (held === hold) {
                StatusBar.popStackEntry(hold.entry);
                hold.entry = push.call(StatusBar, mine);
            }
            return theirs;
        };
        StatusBar.setBarStyle(barStyle, false);
        return () => { if (held === hold) releaseHeld(); };
    } catch {
        held = null;
        return () => {};
    }
}

function releaseHeld(): void {
    const hold = held;
    if (!hold) return;
    held = null;
    try {
        StatusBar.pushStackEntry = hold.push;
        StatusBar.popStackEntry(hold.entry);
    } catch {
        // Nothing more to give back.
    }
}
