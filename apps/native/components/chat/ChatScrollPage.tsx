/**
 * A part of a chat's column that stands whole while it fits its room and scrolls as one page once it is taller (the DM
 * screen's bars and the key card above them, components/chat/DmKeyChangedPane; the banners over the composer; the rooms are
 * utils/chat-column-fit's). A page cut by its room never hides that it scrolls: its scroll bar stays shown (Android), it
 * flashes once when it first opens taller than its room (iOS has no lasting bar), and its bottom edge fades. A room of 0
 * folds it away until the room comes back. Taps go through with the keyboard up, so a banner's ✕ works while typing.
 */
import React, { useEffect, useRef } from 'react';
import { ScrollView } from 'react-native';

/** How far the bottom edge fades on Android while more of the page is below. */
export const CHAT_PAGE_FADE = 32;

export interface ChatScrollPageProps {
    testID: string;
    /** The page's room: it stands whole up to this, and scrolls past it. */
    maxHeight: number;
    children?: React.ReactNode;
}

export function ChatScrollPage({ testID, maxHeight, children }: ChatScrollPageProps) {
    const scrollRef = useRef<ScrollView>(null);
    const flashed = useRef(false);
    const content = useRef(0);
    // Once, the first time the page is taller than a room it is shown in (a folded page shows nothing to flash).
    const flash = () => {
        if (flashed.current || !(maxHeight > 0) || !(content.current > maxHeight)) return;
        flashed.current = true;
        scrollRef.current?.flashScrollIndicators();
    };
    useEffect(flash, [maxHeight]);
    return (
        <ScrollView
            ref={scrollRef}
            testID={testID}
            style={{ flexGrow: 0, flexShrink: 1, maxHeight }}
            keyboardShouldPersistTaps="handled"
            persistentScrollbar
            fadingEdgeLength={CHAT_PAGE_FADE}
            onContentSizeChange={(_w, h) => { content.current = h; flash(); }}
        >
            {children}
        </ScrollView>
    );
}
