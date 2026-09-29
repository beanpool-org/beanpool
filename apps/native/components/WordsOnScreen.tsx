/**
 * What goes with an account's 12 words wherever they are on screen (utils/words-on-screen.ts, utils/words-clipboard.ts):
 * no screenshots while they show, one plain line on a phone with no screen lock, and one next to Copy saying the copy
 * clears in a minute.
 */
import React, { useEffect, useState } from 'react';
import { Platform, Text, type StyleProp, type TextStyle } from 'react-native';
import { useIsFocused } from 'expo-router';
import { COPY_CLEARS_LINE } from '../utils/words-clipboard';
import { NO_SCREEN_LOCK_LINE, holdNoScreenCapture, useNoScreenLock } from '../utils/words-on-screen';

/**
 * The words (or the boxes they are typed into) go inside this: no screenshots or recordings of them. They are drawn only
 * once the block has answered and while their screen is in front; until then `fallback` is (nothing, by default).
 *
 * The block is let go only after they have left the tree: put away (this unmounts with them), or another screen come
 * in front (the render that sees the blur draws `fallback`, and the effect's cleanup, which lets go, runs only once
 * that render is committed). Coming back, they wait for the block again. What was typed is kept by the screen around
 * this, so nothing is lost while they are away.
 */
export function NoScreenCapture({ children, fallback = null }: { children: React.ReactNode; fallback?: React.ReactNode }): React.JSX.Element {
    const focused = useIsFocused();
    const [inForce, setInForce] = useState(false);
    useEffect(() => {
        if (!focused) return;
        const hold = holdNoScreenCapture();
        let current = true;
        void hold.answered.then(() => { if (current) setInForce(true); });
        return () => {
            current = false;
            setInForce(false);
            hold.release();
        };
    }, [focused]);
    return <>{focused && inForce ? children : fallback}</>;
}

/** Under the words, only on a phone with no screen lock at all. Nothing is gated on it. */
export function NoScreenLockNote({ style }: { style?: StyleProp<TextStyle> }): React.JSX.Element | null {
    const noLock = useNoScreenLock();
    if (!noLock) return null;
    return <Text style={style}>{NO_SCREEN_LOCK_LINE}</Text>;
}

/** Next to every Copy of the words. Not in the web build, which leaves the clipboard alone. */
export function CopyClearsNote({ style }: { style?: StyleProp<TextStyle> }): React.JSX.Element | null {
    if (Platform.OS === 'web') return null;
    return <Text style={style}>{COPY_CLEARS_LINE}</Text>;
}
