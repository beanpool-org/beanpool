/**
 * The "Worldwide forum ›" row in a community's Forum (slice F3 part 2; DESIGN-forums-messaging-joint-fable.md §2.2: "each
 * community's Forum gets one row, Worldwide forum ›: it opens that forum in the app if you have joined the worldwide community
 * (the switch that '{community}: new messages ›' already uses) ... Drawn by the app, never needed by a community").
 *
 * - **Where it shows:** in the Forum of any community but the worldwide one itself, for a member this phone keeps as joined
 *   there (a saved community, not a guest's). The worldwide community is the app's one default (GLOBAL_NODE_URL); no other
 *   community is named.
 * - **What it opens:** the same switch a tapped notice from another community makes (utils/push-notice-switch.ts openNoticeIn),
 *   landing on that community's Chat tab, Forum side.
 * - **Not joined:** no row yet. The design's other half (its public pages) waits on slice F7, which builds them; until then a
 *   row there would open a page that isn't there.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { GLOBAL_NODE_URL } from './global-node-url';
import { getSavedNodes, isGuestNode } from './nodes';
import { sameCommunity } from './push-pins';

/** Whether this phone keeps the member as joined on the worldwide community, from another community (false on it, and on any fault). */
export async function worldwideForumJoined(): Promise<boolean> {
    try {
        const anchor = await AsyncStorage.getItem('beanpool_anchor_url');
        if (!anchor || sameCommunity(anchor, GLOBAL_NODE_URL)) return false;
        const saved = (await getSavedNodes()).find((n) => sameCommunity(n.url, GLOBAL_NODE_URL));
        return !!saved && !(await isGuestNode(saved.url));
    } catch {
        return false;
    }
}

/**
 * Moves the phone to the worldwide community and opens its Forum, as a notice from there would. 'switched', 'held' (a join or
 * a switch is under way) or 'failed', as openNoticeIn says.
 */
export async function openWorldwideForum(publicKey: string, recheck: () => Promise<unknown>) {
    const [{ openNoticeIn }, { switchCommunity, communitySwitchUnderWay }, { getPendingOnboarding }] = await Promise.all([
        import('./push-notice-switch'), import('./use-communities'), import('./onboarding-state'),
    ]);
    return openNoticeIn(GLOBAL_NODE_URL, null, async () => '/(tabs)/chats?view=forum', {
        storage: AsyncStorage,
        publicKey,
        joinUnderWay: () => getPendingOnboarding().then((p) => !!p, () => true),
        switchUnderWay: communitySwitchUnderWay,
        switchTo: switchCommunity,
        recheck,
    });
}
