/**
 * useChatPoll — the DM screen's refresh lifecycle, for every other chat.
 *
 * The group, enterprise and event chats each ran a bare `setInterval` that never stopped. This is the same
 * rule app/chat/[id].tsx has always followed, in one place: refresh only while this screen is focused and the
 * app is in the foreground, with one immediate load whenever either becomes true again.
 *
 * The decision itself is in utils/chat-poll (tested); this is only the wiring to expo-router and AppState.
 * `load` must be a stable callback — a new identity on every render would restart the poll on every render.
 */

import { useCallback } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { createChatPoll } from '../../utils/chat-poll';

export function useChatPoll(load: () => void, intervalMs: number): void {
    useFocusEffect(
        useCallback(() => {
            const poll = createChatPoll(load, intervalMs);
            const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
                poll.setAppActive(next === 'active');
            });
            // App state first, then focus: a chat opened while the app is backgrounded must not fetch.
            poll.setAppActive(AppState.currentState === 'active');
            poll.setFocused(true);
            return () => {
                poll.stop();
                sub.remove();
            };
        }, [load, intervalMs]),
    );
}
