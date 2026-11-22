/**
 * The account's block rules, pure (slice S7b; moved out of blocklist.ts for #3354's review, which re-exports them): what the
 * lists say, judged with no store and no native module, so any screen's test can judge with the real rule.
 */

/**
 * Block first, everywhere (slice S7b, scratch/fable-design/DESIGN-s7-blocks-verified-everywhere-fable.md §2.4; Marty, 21 Nov
 * 2026, "all four of Fable's picks"): what the account's blocks say, for the checks that come before a request card, a quiet
 * Accept, a first line across or "Add people I've chatted with". `onPhone`: every key of each person blocked on this phone
 * now. `once`: every key of each person the member blocked here, now or before an unblock the phone still remembers
 * (blocklist.ts getKeysOnceBlocked). `seenThere`: what each community's own list held as the phone last read it that this phone
 * did not put there, with the keys it named as replaced by them (a block made in the web app, on another device, or before
 * a restore): used for these checks alone, never shown, spread or sent (question 2: it stops the quiet Accept and hides the
 * request card, nothing more).
 */
export interface BlockLists {
    onPhone: ReadonlySet<string>;
    once: ReadonlySet<string>;
    seenThere: ReadonlySet<string>;
}

/**
 * Whether the person known by any of `keys` is blocked anywhere (slice S7b): on this phone's list now, or on any community's
 * own list as the phone last read it. Their request card never shows, here or in place, and they are never let in
 * quietly. Someone blocked and later unblocked here is not blocked anywhere: their card shows, as an ordinary request
 * (let-in.ts adds `once` for the quiet Accept, Marty's question 4). Pure.
 */
export function blockedAnywhere(lists: BlockLists, keys: readonly string[]): boolean {
    return keys.some((k) => lists.onPhone.has(k) || lists.seenThere.has(k));
}

/**
 * Whether the person known by any of `keys` is never let in quietly (slice S7b; let-in.ts): blocked anywhere
 * ({@link blockedAnywhere}), or blocked here once and unblocked since (Marty's question 4: their request is a card they
 * answer). Pure.
 */
export function neverLetInQuietly(lists: BlockLists, keys: readonly string[]): boolean {
    return blockedAnywhere(lists, keys) || keys.some((k) => lists.once.has(k));
}
