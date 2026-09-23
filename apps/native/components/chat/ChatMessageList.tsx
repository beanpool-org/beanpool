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

import React, { useCallback } from 'react';
import { FlatList, View, type NativeSyntheticEvent, type NativeScrollEvent } from 'react-native';
import { useGenericKeyboardHandler } from 'react-native-keyboard-controller';
import { scheduleOnRN } from 'react-native-worklets';
import { isAtBottom, isDaySeparator, type ChatListItem } from '../../utils/chat-actions';
import { ChatDaySeparator } from './ChatBubble';
import type { ChatStyles } from './styles';

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
    onScrollBeginDrag?: () => void;
    onAtBottomChange?: (atBottom: boolean) => void;
    /** The oldest loaded message came into view: grow the window by a page. */
    onEndReached?: () => void;
    ListEmptyComponent?: React.ComponentType<any> | React.ReactElement | null;
    /** Inverted: the FOOTER is what renders at the visual top, above the oldest message. */
    ListFooterComponent?: React.ComponentType<any> | React.ReactElement | null;
    contentContainerStyle?: any;
}

export function ChatMessageList({
    listRef, items, styles, renderMessage, activeId, onScrollBeginDrag, onAtBottomChange,
    onEndReached, ListEmptyComponent, ListFooterComponent, contentContainerStyle,
}: Props) {
    const scrollToBottom = useCallback((animated: boolean) => {
        scrollChatToBottom(listRef, animated);
    }, [listRef]);

    // Keep the newest messages pinned to the bottom as the keyboard slides in, following it frame by frame
    // (WhatsApp-style) instead of a single delayed jump that lands before the avoid-view padding has settled.
    //
    // The GENERIC variant: the plain `useKeyboardHandler` also runs `useResizeMode()`, which sets the window to
    // ADJUST_RESIZE on mount and back to the default on unmount. That would undo the ADJUST_NOTHING that
    // ChatKeyboardAvoidingView owns — permanently in the DM, where this list mounts only after the first read,
    // and on popping a chat that sat on top of another chat. This handler only scrolls; it needs no mode.
    useGenericKeyboardHandler({
        onMove: () => {
            'worklet';
            scheduleOnRN(scrollToBottom, false);
        },
        onEnd: () => {
            'worklet';
            scheduleOnRN(scrollToBottom, false);
        },
    }, [scrollToBottom]);

    // List cells are siblings, and a later-mounted cell paints over an earlier one — so the reaction picker
    // and the action buttons (positioned at top/bottom: -45, overflowing into adjacent rows) rendered BEHIND
    // sibling bubbles. zIndex inside the row cannot win across cells; the whole cell has to be lifted.
    const renderCell = useCallback(({ children, item, style, ...props }: any) => {
        const lifted = !!activeId && item?.id === activeId;
        return (
            <View {...props} style={[style, lifted ? { zIndex: 9999, elevation: 9999, overflow: 'visible' } : { zIndex: 1 }]}>
                {children}
            </View>
        );
    }, [activeId]);

    const renderItem = useCallback(({ item }: { item: ChatListItem }) => {
        if (isDaySeparator(item)) return <ChatDaySeparator label={item.label} styles={styles} />;
        return renderMessage(item);
    }, [renderMessage, styles]);

    const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
        onAtBottomChange?.(isAtBottom(e.nativeEvent.contentOffset.y));
    }, [onAtBottomChange]);

    return (
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
            onScroll={onAtBottomChange ? onScroll : undefined}
            scrollEventThrottle={onAtBottomChange ? 100 : undefined}
            // Inverted list: "end" = the oldest loaded message (visual top).
            onEndReachedThreshold={0.8}
            onEndReached={onEndReached}
            onScrollBeginDrag={onScrollBeginDrag}
            ListEmptyComponent={ListEmptyComponent}
            ListFooterComponent={ListFooterComponent}
        />
    );
}
