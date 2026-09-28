/**
 * What goes with an account's 12 words wherever they are on screen (utils/words-on-screen.ts, utils/words-clipboard.ts):
 * no screenshots while they show, one plain line on a phone with no screen lock, and one next to Copy saying the copy
 * clears in a minute.
 */
import React, { useCallback } from 'react';
import { Platform, Text, type StyleProp, type TextStyle } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { COPY_CLEARS_LINE } from '../utils/words-clipboard';
import { NO_SCREEN_LOCK_LINE, holdNoScreenCapture, useNoScreenLock } from '../utils/words-on-screen';

/**
 * Drawn with the words (or the boxes they are typed into): no screenshots or recordings while it is mounted and its
 * screen is in front. Released when the words go, and when another screen comes in front of this one (a screen left in
 * the stack stays mounted, and the next one must stay screenshot-able).
 */
export function NoScreenCapture(): null {
    useFocusEffect(useCallback(() => holdNoScreenCapture(), []));
    return null;
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
