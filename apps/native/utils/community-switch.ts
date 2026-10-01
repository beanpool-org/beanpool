/**
 * "The phone moved to another community", said by every place a member moves it: the BeanPool sheet
 * (use-communities.ts), Settings' Advanced switch, the not-recognised screen, joining another community, a delete that
 * leaves this community for the next one (delete-here.ts), Sign Out (account-leaves-phone.ts), and the full-screen
 * "Update required" itself (components/ForceUpdateBlock.tsx).
 *
 * The update screen listens (utils/force-update.ts `communitySwitched`): its block was the community left's, so it
 * comes down, and the community now in use is asked at once. So one community's floor never covers another community on
 * the same phone, and switching back to that community puts its block up again.
 *
 * No imports, so anything can say it. A listener that throws is skipped.
 */
const listeners = new Set<() => void>();

export function communitySwitched(): void {
    for (const listener of [...listeners]) {
        try { listener(); } catch { /* one listener's trouble is not the switch's */ }
    }
}

/** Calls `listener` after every switch. Returns the way to stop. */
export function onCommunitySwitched(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
