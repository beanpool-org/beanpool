/**
 * What a member typed in a chat and did not send, kept for that chat while this page is open (WhatsApp's way: leave a chat by
 * its back arrow or by choosing Chat in the menu, come back, and the words are still in the box). In memory only: nothing is
 * written to the browser's storage, a reload forgets it, and each account's drafts are its own (the key starts with its key).
 * A send empties the box, and an empty box keeps nothing.
 *
 * A send's answer can land after the member has left the chat (its back arrow, Chat in the menu, another chat opened): the
 * words that went are then dropped by the chat's key taken at Send (draftSent), never by whichever box shows by then.
 */
import { useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react';

const drafts = new Map<string, string>();
/** The box that shows each chat now, by its key: how to take the words that went out of it. */
const showing = new Map<string, (went: string) => void>();

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

/**
 * A send from the box of the chat `key` names was taken, with the words `sent`. `key` is the one taken when Send was pressed:
 * the member may be anywhere by now. The words that went are no longer that chat's draft: not kept for it, and not in a box
 * that shows that chat now (the same box, or the chat opened again since). A box showing another chat is never touched, and
 * words written since stay (the kept or shown words are no longer the words that went). A refused or failed send never
 * calls this: its words stay.
 */
export function draftSent(key: string | null, sent: string): void {
    const went = sent.trim();
    if (!key || !went) return;
    if (drafts.get(key)?.trim() === went) drafts.delete(key);
    showing.get(key)?.(went);
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
export function useKeptDraft(key: string | null, keepable: string, setDraft: Dispatch<SetStateAction<string>>): void {
    const latest = useRef(keepable);
    // The key the box is showing. Only a render for that same key says what its box holds: the render that already names the
    // next chat (or none) can carry words meant for the next one (a way in's prefill set with it), never this one's.
    const showingKey = useRef<string | null>(null);
    if (key !== null && key === showingKey.current) latest.current = keepable;
    useLayoutEffect(() => {
        if (!key) return;
        const kept = keptDraft(key);
        showingKey.current = key;
        // What is in the box from now: kept again as it is if the chat closes before the member types anything.
        latest.current = kept;
        setDraft(kept);
        // A send of this chat's that lands while this box shows it (draftSent) takes its words out, if they are still here.
        const takeOut = (went: string) => setDraft((now) => (now.trim() === went ? '' : now));
        showing.set(key, takeOut);
        return () => {
            keepDraft(key, latest.current);
            showingKey.current = null;
            if (showing.get(key) === takeOut) showing.delete(key);
        };
    }, [key]);
}
