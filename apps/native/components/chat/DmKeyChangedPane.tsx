/**
 * Where the DM screen's key-changed card sits (components/chat/DmKeyChangedBanner.tsx): under the header, taking as much
 * of the room above the paused box as it needs, up to all of it (utils/dm-key-change dmKeyBannerMaxHeight). Nothing can
 * be sent while it is up, so the thread gives way. A card taller than the room fills it and scrolls as the page: its
 * cut edge sits on the box, its scroll bar stays shown and its bottom edge fades, so the code, the tick and "Continue
 * with the new key" are never in a small scroll inside the card with no hint (walk of 17 Nov, 320 dp at 1.3× text).
 *
 * The box can't be typed in while the card is up (ChatComposer disabled), so a keyboard still up when the pause starts,
 * or raised meanwhile, is put away: with it up the card had only its title (the same walk).
 */
import React, { useEffect, useRef } from 'react';
import { ScrollView } from 'react-native';
import { KeyboardController, useKeyboardState } from 'react-native-keyboard-controller';
import { DmKeyChangedBanner, type DmKeyChangedBannerProps } from './DmKeyChangedBanner';

export interface DmKeyChangedPaneProps extends DmKeyChangedBannerProps {
    /** The room above the paused box, as dmKeyBannerMaxHeight works it out. */
    maxHeight: number;
}

/** How far the bottom edge fades on Android while more of the card is below. */
export const DM_KEY_PANE_FADE = 32;

export function DmKeyChangedPane({ maxHeight, ...banner }: DmKeyChangedPaneProps) {
    const keyboardUp = useKeyboardState((s) => s.isVisible);
    useEffect(() => {
        if (keyboardUp) void KeyboardController.dismiss();
    }, [keyboardUp]);
    // iOS has no lasting scroll bar: show it once when the card opens taller than its room.
    const scrollRef = useRef<ScrollView>(null);
    const flashed = useRef(false);
    return (
        <ScrollView
            ref={scrollRef}
            testID="dm-key-pane"
            style={{ flexGrow: 0, flexShrink: 1, maxHeight }}
            keyboardShouldPersistTaps="handled"
            persistentScrollbar
            fadingEdgeLength={DM_KEY_PANE_FADE}
            onContentSizeChange={(_w, h) => {
                if (!flashed.current && h > maxHeight) {
                    flashed.current = true;
                    scrollRef.current?.flashScrollIndicators();
                }
            }}
        >
            <DmKeyChangedBanner {...banner} />
        </ScrollView>
    );
}
