import React from 'react';
import { StatusBar, type StatusBarStyle } from 'expo-status-bar';
import { useNavigationState, useRoute } from '@react-navigation/native';
import { screenShowing } from '../utils/screen-showing';

/**
 * A screen's own status bar that counts only while the screen can be seen (utils/screen-showing.ts): for a bar made for a
 * screen's own dark header, which must not stay on the screens opened over it.
 *
 * React Native keeps every mounted StatusBar in one stack, the newest winning, and a screen under another stays mounted. The
 * tabs' light bar (for their dark header) therefore stayed on every screen opened from them that set no bar of its own, and
 * in Light those showed a white clock and white icons on a light page (WALK 3 phone, 17 Nov 2026: the guest chat; 44 screens
 * set none). This bar leaves the stack when another screen covers its own, so the screen on top reads the root layout's bar,
 * dark icons on Light and light on the dark themes, unless it sets one itself; and it comes back on top when its screen
 * shows again. A see-through screen over it (new-listing) keeps it: the bar still sits over this screen's header.
 */
export function ScreenStatusBar({ style }: { style: StatusBarStyle }) {
    const { key } = useRoute();
    const showing = useNavigationState((state) => screenShowing(state, key));
    return showing ? <StatusBar style={style} /> : null;
}
