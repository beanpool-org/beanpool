/**
 * Message on a contact who is in another community this phone holds (Marty, 19 Nov 2026, "yes to all 5", slice S0 of
 * scratch/fable-design/DESIGN-no-switch-messaging-fable.md): the phone moves there with no question and the chat with them
 * opens, as a tapped notice moves it (push-notice-switch.ts `openNoticeIn`, the one switch). "Holds" is the Contacts screen's
 * own list of the member's communities (use-contacts.ts `communities`: kept, and not a guest's look). For a community the
 * phone doesn't hold, Contacts still asks first, as it did.
 *
 * - **Who opens the chat.** The phone can only start a chat in the community it is set to, so the person waits here, in
 *   memory alone, while the phone moves: Contacts opens over the tabs where the root guard lands the member
 *   (member-landing.ts `openAfterLanding`, `/contacts?message=<key>`) and takes them ({@link takeMessageAfterSwitch}), for that
 *   account, that community and that person only, once, within {@link NOTICE_LANDING_MS}. Nothing of it is written down. A
 *   link naming someone does nothing on its own (no tap left them waiting), and nor does Contacts opened by hand while one
 *   waits (the guard held the member elsewhere, so Contacts never opened for it).
 * - **What holds the member wins**, as for a notice: a join or a switch under way moves nothing, and where the guard sends the
 *   member anywhere but the tabs, nothing opens.
 */
import { NOTICE_LANDING_MS } from './member-landing';
import { openNoticeIn, type NoticeSwitch, type NoticeSwitchDeps } from './push-notice-switch';
import { sameCommunity } from './push-pins';

let waiting: { key: string; community: string; publicKey: string; until: number } | null = null;

/**
 * Whom Contacts opens a chat with, now that the landing opened it for `asked` in `community` for `publicKey`: taken once,
 * and only for that account, community and person within the time; null otherwise. One for another account, or out of
 * time, is dropped.
 */
export function takeMessageAfterSwitch(publicKey: string, community: string | null, asked: string | null | undefined, now: number = Date.now()): string | null {
    if (waiting && (waiting.publicKey !== publicKey || !(now < waiting.until))) waiting = null;
    if (!waiting || !asked || waiting.key !== asked || !sameCommunity(waiting.community, community)) return null;
    const { key } = waiting;
    waiting = null;
    return key;
}

/**
 * The tap: the phone moves to `community` and Contacts opens there, which opens the chat with `key`. The person is forgotten
 * again if the phone didn't move. Never throws.
 */
export async function messageInHeldCommunity(key: string, community: string, deps: NoticeSwitchDeps, now: number = Date.now()): Promise<NoticeSwitch> {
    waiting = { key, community, publicKey: deps.publicKey, until: now + NOTICE_LANDING_MS };
    const result = await openNoticeIn(community, null, async () => `/contacts?message=${encodeURIComponent(key)}` as const, deps);
    if (result !== 'switched') waiting = null;
    return result;
}
