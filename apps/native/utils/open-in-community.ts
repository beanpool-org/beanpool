/**
 * What a chat can't do in place (slices S2 and S6, DESIGN-no-switch-messaging-fable.md §6): the phone moves to the chat's own
 * community, through the one switch and its guards (utils/push-notice-switch.ts openNoticeIn), and opens `route` there. Asked
 * only on the member's tap. `held`: a join or a switch is under way, nothing moved; `failed`: nothing moved. The caller says so.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { LandingRoute } from './member-landing';
import type { NoticeSwitch } from './push-notice-switch';

export async function openInCommunity(community: string, route: LandingRoute, publicKey: string, recheck: () => Promise<unknown>): Promise<NoticeSwitch> {
    const [{ openNoticeIn }, { switchCommunity, communitySwitchUnderWay }, { getPendingOnboarding }] = await Promise.all([
        import('./push-notice-switch'), import('./use-communities'), import('./onboarding-state'),
    ]);
    return openNoticeIn(community, null, async () => route, {
        storage: AsyncStorage,
        publicKey,
        joinUnderWay: () => getPendingOnboarding().then((p) => !!p, () => true),
        switchUnderWay: communitySwitchUnderWay,
        switchTo: switchCommunity,
        recheck,
    });
}
