/**
 * "The phone moved to another community, or now has none", said by every place that writes or removes the phone's
 * community (`beanpool_anchor_url`):
 * - switches: the BeanPool sheet (use-communities.ts), Settings' Advanced switch and its reset, the not-recognised
 *   screen, the full-screen "Update required" itself (update-block-escape.ts), the deep link's Switch & Join
 *   (app/_layout.tsx);
 * - joins: joining another community (join-another-community.ts, its undo too), Welcome's invite joins, the global
 *   joins (welcome.tsx `finishGlobalJoin`, global-join-existing.ts `enterGlobalCommunity`), a restore
 *   (restore-account.ts);
 * - leaving: a delete that leaves this community for the next one (delete-here.ts), Sign Out and the node-mismatch
 *   delete (account-leaves-phone.ts), every wipe of the account's app storage (identity.ts
 *   `wipeIdentityScopedStorage`), the deep link's "Wipe & Join Fresh" (app/_layout.tsx) and People's "Wipe & Restart".
 * __tests__/community-switch-sweep.test.ts finds every write and removal in the app and fails on one not listed there.
 * The one exception is pillar-sync.ts `discoverAnchor`, which writes one only in a development build with none set.
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
