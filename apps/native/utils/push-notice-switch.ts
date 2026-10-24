/**
 * A tap on a notice from another community this phone keeps (push-notice-check.ts `followTap`, once the notice checked out
 * as that community's, for this account): the phone moves there and the notice opens there (Marty, 24 Oct: "a push
 * notification doesn't direct me to a specific node, it just drops you onto the node you are already on").
 *
 * - **The one switch.** The phone moves as a tap on that community's row on the BeanPool sheet moves it
 *   (use-communities.ts `switchCommunity`), never by a copy of it: its own database, the anchor, the update screen told,
 *   then the bounce through Welcome.
 * - **Opened by the root guard, not by a timer.** Before the bounce the root layout's recognition is asked again for the
 *   community now in use (as the update screen's switch and a guest visit ask it), and the notice's screen is left for the
 *   guard (member-landing.ts `openAfterLanding`). The guard opens it over the tabs once it lands the member there, for this
 *   community and this account.
 * - **What holds the member wins.** A join part-way through (the wizard keeps the member on Welcome: nothing moves), a
 *   switch already under way (nothing more moves), then whatever the guard does with the community now in use: the
 *   not-recognised screen for a key it doesn't know or closed, the recovery prompt, a claim or a landing a screen asked
 *   for, the full-screen "Update required" (which covers every screen). The notice opens only where the guard lets the
 *   member into the tabs.
 * - **Counted either way** (notice-counts.ts): as the community becomes the one in use its count goes back to nothing;
 *   held, its row on the BeanPool sheet shows it.
 */
import type { NoticeRoute } from './push-notice-check';
import { countNotice } from './notice-counts';
import { openAfterLanding } from './member-landing';

interface Storage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
}

export interface NoticeSwitchDeps {
    storage: Storage;
    /** The account on the phone, which the notice was signed for. */
    publicKey: string;
    /** A join part-way through (onboarding-state.ts `getPendingOnboarding`): the root guard keeps the member in its wizard. */
    joinUnderWay(): Promise<boolean>;
    /** A switch already under way (use-communities.ts `communitySwitchUnderWay`). */
    switchUnderWay(): boolean;
    /** The BeanPool sheet's switch (use-communities.ts `switchCommunity`). */
    switchTo(url: string, beforeWelcome: () => Promise<void>): Promise<void>;
    /** The root layout's recognition, asked again (app/NodeStatusContext.tsx `recheck`): it reads the phone's community. */
    recheck(): Promise<unknown>;
}

/** `switched`: the phone moved, and the guard opens the notice if it lands the member on the tabs. */
export type NoticeSwitch = 'switched' | 'held' | 'failed';

/**
 * Notice `id`, tapped, from `community`: counted, then the phone moves there and the guard is asked to open `route()`
 * (asked only once the phone is moving, so a held switch asks that community nothing). Never throws.
 */
export async function openNoticeIn(community: string, id: string, route: () => Promise<NoticeRoute>, deps: NoticeSwitchDeps): Promise<NoticeSwitch> {
    await countNotice(deps.storage, community, id);
    try {
        if (deps.switchUnderWay() || await deps.joinUnderWay()) {
            console.log(`[Push] A notice from ${community}: the phone stays where it is (a join or a switch is under way)`);
            return 'held';
        }
        // Asked of that community while the phone moves; its answer is wanted only before the bounce.
        const landing = route().catch((): NoticeRoute => '/(tabs)');
        await deps.switchTo(community, async () => {
            const answer = await deps.recheck().catch(() => 'unknown');
            // The guard lets the member in only for these (app/_layout.tsx); any other answer holds them where it does, and
            // the notice is left for nobody.
            if (answer === 'member' || answer === 'unknown') openAfterLanding(await landing, community, deps.publicKey);
        });
        return 'switched';
    } catch (e) {
        console.warn(`[Push] Could not move to ${community} for a tapped notice`, e);
        return 'failed';
    }
}
