/**
 * A part of a chat's column that stands whole while it fits its room and scrolls as one page once it is taller (the DM
 * screen's bars and the key card above them, components/chat/DmKeyChangedPane; the About chip over the composer; the rooms
 * are utils/chat-column-fit's). A page cut by its room never hides that it scrolls: its scroll bar stays shown (Android), it
 * flashes once when it first opens taller than its room (iOS has no lasting bar), and the edge with more beyond it fades
 * (Android). A room of 0
 * folds it away until the room comes back. Taps go through with the keyboard up, so a ✕ or Release in it works while typing.
 * A page anchored at its end (the bars, over the thread) is kept scrolled there whenever its room or its content changes, so
 * what gives way first is its top (the deals strip before the listing's header before the release bar); the key card's page
 * keeps its start, the card's words.
 */
import React, { useEffect, useRef } from 'react';
import { ScrollView } from 'react-native';

/** How far an edge fades on Android while more of the page is beyond it. */
export const CHAT_PAGE_FADE = 32;

export interface ChatScrollPageProps {
    testID: string;
    /** The page's room: it stands whole up to this, and scrolls past it. */
    maxHeight: number;
    /** The end kept in view while the page is cut: 'start' (the default) or 'end', the part next to what is under it. */
    anchor?: 'start' | 'end';
    children?: React.ReactNode;
}

export function ChatScrollPage({ testID, maxHeight, anchor = 'start', children }: ChatScrollPageProps) {
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
    // Its frame or its content moved: an end-anchored page goes back to its end (a no-op while it stands whole).
    const toEnd = () => { if (anchor === 'end') scrollRef.current?.scrollToEnd({ animated: false }); };
    return (
        <ScrollView
            ref={scrollRef}
            testID={testID}
            style={{ flexGrow: 0, flexShrink: 1, maxHeight }}
            keyboardShouldPersistTaps="handled"
            persistentScrollbar
            fadingEdgeLength={CHAT_PAGE_FADE}
            onLayout={toEnd}
            onContentSizeChange={(_w, h) => { content.current = h; flash(); toEnd(); }}
        >
            {children}
        </ScrollView>
    );
}
