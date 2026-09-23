/**
 * chat-poll — when a chat screen is allowed to ask the node for new messages.
 *
 * Every chat on the phone refreshes on a timer. The DM screen has always gated that timer on two things at
 * once (app/chat/[id].tsx): the screen is FOCUSED, and the app is in the FOREGROUND. The group, enterprise and
 * event chats did not — they ran `setInterval(load, 15000)` from mount to unmount, so a chat left open behind
 * another screen, or on a phone in a pocket, kept pulling a page of messages every fifteen seconds. On the old
 * Android phones and paid data most of our members are on, that is roughly 3-4 MB an hour for nothing.
 *
 * The decision lives here, away from React, so it can be tested with fake timers rather than a device:
 *   - poll only while focused AND active;
 *   - the first tick is immediate, so coming back to a chat shows what arrived while you were away without
 *     waiting out an interval;
 *   - going away clears the timer rather than letting a tick fire and be thrown out.
 *
 * `useChatPoll` (components/chat/useChatPoll.ts) is the ten lines that wire this to expo-router's focus and
 * React Native's AppState. Nothing else in this file knows either exists.
 */

export interface ChatPoll {
    /** The screen gained or lost focus. */
    setFocused(focused: boolean): void;
    /** The app came to the foreground or left it. */
    setAppActive(active: boolean): void;
    /** Leaving for good: stop the timer and stay stopped. */
    stop(): void;
    /** Whether a timer is running right now — for tests and for reading the state in a debugger. */
    isPolling(): boolean;
}

/**
 * A poll that runs only while the chat is both focused and in the foreground.
 *
 * Starts stopped: the caller says what is true (focus, app state) and the poll starts itself if both hold.
 * That ordering matters — a chat opened while the app is backgrounded must not fetch.
 */
export function createChatPoll(load: () => void, intervalMs: number): ChatPoll {
    let focused = false;
    let appActive = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const sync = () => {
        const shouldPoll = focused && appActive;
        if (shouldPoll && !timer) {
            // One load the moment the chat is watchable again, then the usual cadence.
            load();
            timer = setInterval(load, intervalMs);
        } else if (!shouldPoll && timer) {
            clearInterval(timer);
            timer = null;
        }
    };

    return {
        setFocused(next: boolean) { focused = next; sync(); },
        setAppActive(next: boolean) { appActive = next; sync(); },
        stop() { focused = false; appActive = false; sync(); },
        isPolling() { return timer !== null; },
    };
}
