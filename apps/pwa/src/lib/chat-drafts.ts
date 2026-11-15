/**
 * What a member typed in a chat and did not send, kept for that chat while this page is open (WhatsApp's way: leave a chat by
 * its back arrow or by choosing Chat in the menu, come back, and the words are still in the box). In memory only: nothing is
 * written to the browser's storage, a reload forgets it, and each account's drafts are its own (the key starts with its key).
 * A send empties the box, and an empty box keeps nothing.
 */
import { useLayoutEffect, useRef } from 'react';

const drafts = new Map<string, string>();

/** The key a chat's draft is kept under: the account, then what kind of chat, then its id. */
export function draftKey(account: string | null | undefined, kind: 'chat' | 'event' | 'outside' | 'forum', id: string | null | undefined): string | null {
    return account && id ? `${account.toLowerCase()}|${kind}|${id}` : null;
}

export function keepDraft(key: string, text: string): void {
    if (text.trim()) drafts.set(key, text);
    else drafts.delete(key);
}

export function keptDraft(key: string): string {
    return drafts.get(key) ?? '';
}

/** Tests only: forget every kept draft. */
export function forgetDraftsForTests(): void {
    drafts.clear();
}

/**
 * The box of the chat `key` names starts with the words kept for it, in the commit that draws it (a layout effect, so words
 * typed the moment the chat shows are never thrown away after), and keeps `keepable` when the chat closes or another opens.
 * `keepable` is what the box holds as a draft: empty while it holds something else (an edit of a line already sent).
 * A null key (no chat open) does nothing.
 */
export function useKeptDraft(key: string | null, keepable: string, setDraft: (text: string) => void): void {
    const latest = useRef(keepable);
    // The key the box is showing. Only a render for that same key says what its box holds: the render that already names the
    // next chat (or none) can carry words meant for the next one (a way in's prefill set with it), never this one's.
    const showing = useRef<string | null>(null);
    if (key !== null && key === showing.current) latest.current = keepable;
    useLayoutEffect(() => {
        if (!key) return;
        const kept = keptDraft(key);
        showing.current = key;
        // What is in the box from now: kept again as it is if the chat closes before the member types anything.
        latest.current = kept;
        setDraft(kept);
        return () => {
            keepDraft(key, latest.current);
            showing.current = null;
        };
    }, [key]);
}
