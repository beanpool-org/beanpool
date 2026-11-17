/**
 * The message list every chat uses: inverted, so the newest message is on screen from the first frame and
 * stays above the composer when the keyboard opens.
 *
 * The group and event chats used a top-down list that only scrolled on content-size change — which is why
 * "new message in group is hidden behind kb" and "when you click send it doesn't follow the message down"
 * (Damo, 2026-09-23). Inverting it is the fix, and the reasons the DM screen gives for inverting (no jerky
 * ride to the bottom on open, no scrollToEnd after every render batch) apply just as much there.
 *
 * Also here, because every chat needs them and only the DM screen had them:
 *  - day separators between calendar days (built by utils/chat-actions.buildChatListItems);
 *  - the cell lift, so a reaction picker overflowing its row is not painted over by the next row;
 *  - following the keyboard frame by frame as it opens;
 *  - growing the history window when the oldest loaded message comes into view (onEndReached).
 *
 * onEndReached is wired by the DM screen only. A DM reads its messages out of this phone's own database, so it
 * grows one window; a group, enterprise or event chat reads the node, and all three of those routes cap `limit`
 * at 100 and page with `offset` — so past 100 messages the DM's grow-the-window move stalls and those chats
 * need offset paging (fetch the older page, merge it under the live poll's window, know when history ends).
 * That design is not decided yet, so they still open on their most recent page and stop there, as they did
 * before this component existed.
 */

import React, { useCallback, useLayoutEffect, useRef } from 'react';
import { FlatList, View, type LayoutChangeEvent, type NativeSyntheticEvent, type NativeScrollEvent } from 'react-native';
import { useKeyboardHandler } from 'react-native-keyboard-controller';
import { scheduleOnRN } from 'react-native-worklets';
import { isAtBottom, isDaySeparator, isOldLinesLabel, isRemovedRun, type ChatListItem } from '../../utils/chat-actions';
import { chatMenuClosesOnDrag, chatMenuLineGone, type ChatOpenLine } from '../../utils/chat-column-fit';
import { ChatDaySeparator, ChatOldLinesLabel, ChatRemovedRunLine } from './ChatBubble';
import { ChatFoldProvider } from './ChatFold';
import { CHAT_EMOJI_ROW_PAST_CELL, type ChatStyles } from './styles';

/** The list is inverted, so "the bottom" is offset 0. */
export function scrollChatToBottom(listRef: React.RefObject<FlatList<any> | null>, animated: boolean) {
    listRef.current?.scrollToOffset({ offset: 0, animated });
}

interface Props {
    listRef: React.RefObject<FlatList<any> | null>;
    /** Already reversed and interleaved with day pills — see buildChatListItems. */
    items: ChatListItem[];
    styles: ChatStyles;
    renderMessage: (item: any) => React.ReactElement | null;
    /** The one row whose cell is lifted above its siblings (its picker or action bar is open). */
    activeId?: string | null;
    /** The open line's emoji row while it is up, and the side of the line it opens on (ChatEmojiPicker's `position`). */
    activeEmojiRow?: 'top' | 'bottom' | null;
    /**
     * Close the open line's menu. Called when the thread is dragged while all of the line and its menu are in view (or none of
     * it), and as soon as the line has left the thread, whatever moved it (utils/chat-column-fit chatMenuClosesOnDrag,
     * chatMenuLineGone). A line partly out of view keeps its menu while the thread is dragged, so its actions are a scroll away.
     */
    onCloseMenu?: () => void;
    onAtBottomChange?: (atBottom: boolean) => void;
    /** The oldest loaded message came into view: grow the window by a page. */
    onEndReached?: () => void;
    ListEmptyComponent?: React.ComponentType<any> | React.ReactElement | null;
    /** Inverted: the FOOTER is what renders at the visual top, above the oldest message. */
    ListFooterComponent?: React.ComponentType<any> | React.ReactElement | null;
    contentContainerStyle?: any;
}

export function ChatMessageList({
    listRef, items, styles, renderMessage, activeId, activeEmojiRow, onCloseMenu, onAtBottomChange,
    onEndReached, ListEmptyComponent, ListFooterComponent, contentContainerStyle,
}: Props) {
    const scrollToBottom = useCallback((animated: boolean) => {
        scrollChatToBottom(listRef, animated);
    }, [listRef]);

    // Keep the newest messages pinned to the bottom as the keyboard slides in, following it frame by frame
    // (WhatsApp-style) instead of a single delayed jump that lands before the avoid-view padding has settled.
    useKeyboardHandler({
        onMove: () => {
            'worklet';
            scheduleOnRN(scrollToBottom, false);
        },
        onEnd: () => {
            'worklet';
            scheduleOnRN(scrollToBottom, false);
        },
    }, [scrollToBottom]);

    // Where the open line is, as the phone lays it out (utils/chat-column-fit ChatOpenLine): the thread's height and how far it
    // is scrolled, the open line's cell, and its emoji row, which is drawn outside the cell. A drag closes the menu only while
    // all of the line and its menu are in view, so a line taller than the thread keeps its menu to scroll to (emulator walk
    // 146), and the menu closes as soon as the line has left the thread, so it never stays open, with the bars it folded, on a
    // line the member can't see (#3288 review). The place is kept after the line's cell scrolls out of the list's window.
    const threadHeight = useRef<number | null>(null);
    const offset = useRef(0);
    const activeLine = useRef<{ id: string; y: number; height: number } | null>(null);
    // What the cell's, the thread's and the scroll's handlers read: a cell's handler is made once per open line, never per render.
    const menu = useRef({ activeId, activeEmojiRow, onCloseMenu });
    useLayoutEffect(() => { menu.current = { activeId, activeEmojiRow, onCloseMenu }; });
    // A line opened again is placed afresh by its cell's next layout: where it was the last time may be long gone (new lines).
    useLayoutEffect(() => { activeLine.current = null; }, [activeId]);
    const openLine = useCallback((): ChatOpenLine | null => {
        const { activeId: id, activeEmojiRow: row } = menu.current;
        const line = activeLine.current;
        if (!id || !line || line.id !== id || threadHeight.current === null) return null;
        return {
            thread: threadHeight.current, offset: offset.current, y: line.y, height: line.height,
            above: row === 'top' ? CHAT_EMOJI_ROW_PAST_CELL : 0, below: row === 'bottom' ? CHAT_EMOJI_ROW_PAST_CELL : 0,
        };
    }, []);
    const closeIfGone = useCallback(() => {
        if (chatMenuLineGone(openLine())) menu.current.onCloseMenu?.();
    }, [openLine]);
    // List cells are siblings, and a later-mounted cell paints over an earlier one — so the reaction picker
    // and the action buttons (positioned at top/bottom: -45, overflowing into adjacent rows) rendered BEHIND
    // sibling bubbles. zIndex inside the row cannot win across cells; the whole cell has to be lifted.
    const renderCell = useCallback(({ children, item, style, onLayout, ...props }: any) => {
        const lifted = !!activeId && item?.id === activeId;
        const onLiftedLayout = (e: LayoutChangeEvent) => {
            activeLine.current = { id: item.id, y: e.nativeEvent.layout.y, height: e.nativeEvent.layout.height };
            onLayout?.(e);
            closeIfGone();
        };
        return (
            <View
                {...props}
                onLayout={lifted ? onLiftedLayout : onLayout}
                style={[style, lifted ? { zIndex: 9999, elevation: 9999, overflow: 'visible' } : { zIndex: 1 }]}
            >
                {children}
            </View>
        );
    }, [activeId, closeIfGone]);
    const onDrag = useCallback(() => {
        if (chatMenuClosesOnDrag(openLine())) onCloseMenu?.();
    }, [openLine, onCloseMenu]);

    const renderItem = useCallback(({ item }: { item: ChatListItem }) => {
        if (isDaySeparator(item)) return <ChatDaySeparator label={item.label} styles={styles} />;
        if (isRemovedRun(item)) return <ChatRemovedRunLine run={item} styles={styles} />;
        // The label above DM lines from before 1.4.0: conversion code, log row OLDCHAT, remove after 12 Dec 2026.
        if (isOldLinesLabel(item)) return <ChatOldLinesLabel label={item.label} />;
        return renderMessage(item);
    }, [renderMessage, styles]);

    const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
        offset.current = e.nativeEvent.contentOffset.y;
        onAtBottomChange?.(isAtBottom(offset.current));
        closeIfGone();
    }, [onAtBottomChange, closeIfGone]);
    // Where a drag or a fling came to rest, exactly: scroll events are throttled.
    const onScrollEnd = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
        offset.current = e.nativeEvent.contentOffset.y;
        closeIfGone();
    }, [closeIfGone]);

    return (
        <ChatFoldProvider>
            <FlatList
                ref={listRef}
                data={items}
                keyExtractor={(item: any) => item.id}
                renderItem={renderItem}
                CellRendererComponent={renderCell}
                contentContainerStyle={contentContainerStyle ?? styles.listContent}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                inverted
                initialNumToRender={15}
                windowSize={9}
                onScroll={onAtBottomChange || onCloseMenu ? onScroll : undefined}
                // While a line's menu is open, every frame: it closes as the line leaves the thread, not a tenth of a second on.
                scrollEventThrottle={activeId && onCloseMenu ? 16 : onAtBottomChange ? 100 : undefined}
                // Inverted list: "end" = the oldest loaded message (visual top).
                onEndReachedThreshold={0.8}
                onEndReached={onEndReached}
                onScrollBeginDrag={onCloseMenu ? onDrag : undefined}
                onScrollEndDrag={onCloseMenu ? onScrollEnd : undefined}
                onMomentumScrollEnd={onCloseMenu ? onScrollEnd : undefined}
                onLayout={(e: LayoutChangeEvent) => { threadHeight.current = e.nativeEvent.layout.height; closeIfGone(); }}
                ListEmptyComponent={ListEmptyComponent}
                ListFooterComponent={ListFooterComponent}
            />
        </ChatFoldProvider>
    );
}
