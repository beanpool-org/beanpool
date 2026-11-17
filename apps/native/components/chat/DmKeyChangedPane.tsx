/**
 * Everything on the DM screen between the header and the thread (app/chat/[id].tsx): the deals strip, the listing's
 * header and the release bar, and while the chat is paused for a key change, the key card (DmKeyChangedBanner) above them.
 *
 * With the card up they are one page: the card, then the bars, scrolling together in the room above the paused box (utils/
 * dm-key-change dmKeyBannerMaxHeight: the column under the header less the box and a keyboard still up). Nothing can be
 * sent meanwhile, so the thread gives way. A page taller than the room fills it and scrolls: its cut edge sits on the box,
 * its scroll bar stays shown and its bottom edge fades, so the code, the tick and "Continue with the new key" are never in
 * a small scroll inside the card with no hint (walk of 17 Nov, 320 dp at 1.3× text). The bars scroll with the card rather
 * than stand beside it: at 320 × 533 and 1.3× the listing's header, the release bar, the about chip and the box fill the
 * column, so a card beside them had no room, and a bar left out of its sum came off the box (deciding review of 6775428c,
 * finding 1). Without the card the bars are a page of their own in the room utils/chat-column-fit gives them (barsRoom): the
 * column less the box, a keyboard up and one line of the thread. They stand whole while they fit, scroll as a page once they
 * are taller (kept at its end, so the deals strip gives way first, then the listing's header, then the release bar; the
 * brief of #3283's fix round), and fold away while the room has none (typing on a small phone; walk of 17 Nov, the market DM at 320 dp and
 * 1.3×: they left the thread 0 dp and pushed the box under the navigation bar, and with the keyboard up behind it).
 *
 * The box can't be typed in while the card is up (ChatComposer disabled), so a keyboard still up when the pause starts is
 * put away: with it up the card had only its title (the same walk). Once, and again when the chat comes back in front with
 * one up (a screen opened over the chat keeps its own), never on a later show: the keyboard's state is the whole app's,
 * and a sheet the chat opens over the card (Review, Report) raises its own keyboard in it (the same review, finding 2).
 */
import React, { useEffect, useRef } from 'react';
import { KeyboardController, useKeyboardState } from 'react-native-keyboard-controller';
import { useIsFocused } from 'expo-router';
import { DmKeyChangedBanner, type DmKeyChangedBannerProps } from './DmKeyChangedBanner';
import { CHAT_PAGE_FADE, ChatScrollPage } from './ChatScrollPage';

export interface DmKeyChangedPaneProps {
    /** The key card while the chat is paused for a key change, or null. */
    card: DmKeyChangedBannerProps | null;
    /** The page's room above the paused box, as dmKeyBannerMaxHeight works it out. */
    maxHeight: number;
    /**
     * Without the card: the bars' room (utils/chat-column-fit), in which they stand whole, scroll as a page or fold away.
     * Left out, they stand as they are.
     */
    barsRoom?: number;
    /** The bars between the header and the thread: the deals strip, the listing's header, the release bar. */
    children?: React.ReactNode;
}

/** How far the bottom edge fades on Android while more of the page is below. */
export const DM_KEY_PANE_FADE = CHAT_PAGE_FADE;

export function DmKeyChangedPane({ card, maxHeight, barsRoom, children }: DmKeyChangedPaneProps) {
    if (!card) return barsRoom === undefined ? <>{children}</> : <ChatScrollPage testID="chat-bars-page" maxHeight={barsRoom} anchor="end">{children}</ChatScrollPage>;
    return <KeyCardPage card={card} maxHeight={maxHeight}>{children}</KeyCardPage>;
}

function KeyCardPage({ card, maxHeight, children }: DmKeyChangedPaneProps & { card: DmKeyChangedBannerProps }) {
    const keyboardUp = useKeyboardState((s) => s.isVisible);
    const upNow = useRef(keyboardUp);
    useEffect(() => { upNow.current = keyboardUp; }, [keyboardUp]);
    const inFront = useIsFocused();
    // Only when the pause starts or the chat comes back in front: never on keyboardUp, which a sheet's field raises too.
    useEffect(() => {
        if (inFront && upNow.current) void KeyboardController.dismiss();
    }, [inFront]);
    return (
        <ChatScrollPage testID="dm-key-pane" maxHeight={maxHeight}>
            <DmKeyChangedBanner {...card} />
            {children}
        </ChatScrollPage>
    );
}
