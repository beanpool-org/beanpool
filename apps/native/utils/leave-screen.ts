/**
 * The one way out of a screen that a link or a notice can open as the FIRST screen (review of #3228 at 424fb857: a member's
 * forum link opened on a cold start put the members' topic alone in the root Stack, and its ‹ was a bare `router.back()`, so it
 * did nothing; on iOS only a force-quit left it).
 *
 * The app's router (app/+native-intent.ts) opens these screens straight from a link, and a tapped notice (utils/push-notice-check.ts
 * noticeRoute, services/push-notifications.ts) pushes them wherever the app is, which on a cold start can be nothing. So each one
 * leaves the same way: back when there is a screen under it, else to a real screen of its own kind ({@link FIRST_SCREEN_EXITS}),
 * never nowhere. utils/__tests__/first-screen-exits.test.ts holds the table: every such screen x (opened first, opened on top of
 * Home), and every screen a link or a notice names is in it.
 *
 * Kept free of the screens' imports: the table test reads it without loading a screen.
 */
import { MEMBER_FORUM_LIST, VISITOR_FORUM_TAB } from './forum-link';

/**
 * Each screen a link or a notice can open first (its file under app/, as Expo Router names it), and where its way out goes when
 * nothing is under it: its own list where it has one, else Home. The root guard (app/_layout.tsx) still decides for a phone with no
 * account, as it does at the app's start: Home becomes the first screen's welcome.
 */
export const FIRST_SCREEN_EXITS = {
    // The forum's links (utils/forum-link.ts): the members' topic to the Chat tab's Forum side, where its "topic gone" line shows;
    // the visitors' topic to the visitors' Forum tab.
    'forum/[id]': MEMBER_FORUM_LIST,
    'forum-public/[id]': VISITOR_FORUM_TAB,
    // A shared event or listing (`https://<node>/?post=<id>`) and a post's notice.
    'post/[id]': '/(tabs)',
    // A message's notice, a person's or a group's (a group's vote too): the Chat tab.
    'chat/[id]': '/(tabs)/chats',
    // A group's invitation: the Chat tab, where the groups are.
    'group/[id]': '/(tabs)/chats',
    // A Learn page (Local knowledge), My suggestions, and To check, from their notice: Learn's list for the suggestions, Home for Learn.
    'learn': '/(tabs)',
    'learn/mine': '/learn',
    'learn/check': '/learn',
    'learn/check/[id]': '/learn/check',
    // An enterprise's keepers' console, from its vote's notice.
    'treasury-manage': '/(tabs)',
    // Shared outside, from the notice that someone asked to join after a shared listing: the app's start, where the root guard
    // lands an account on Home.
    'shared-outside': '/',
    // Find a community, from the phone's own notice of an answer to its request.
    'find-community': '/(tabs)',
    // A re-key code's link.
    'rekey-code': '/(tabs)',
    // The door links (utils/global-link.ts, utils/open-door.ts) and the BeanPool sheet the global link offers a member.
    'join-open-door': '/(tabs)',
    'beanpool': '/(tabs)',
    // A post shared outside its community (utils/peek-link.ts), a community's card (utils/community-card-link.ts), the hall
    // poster (utils/hall-link.ts), a claim (utils/claim-link.ts), the web app's pairing QR and its other way (utils/pair-link.ts,
    // utils/pair-in.ts).
    // The peek and the card are for a phone with or without an account: the app's start, where the root guard decides. Bringing an
    // account to the phone (pair-in) is for a phone with none: the first screen.
    'peek': '/',
    'community-card': '/',
    'hall': '/(tabs)',
    'claim-community': '/(tabs)',
    'pair-device': '/(tabs)',
    'pair-in': '/welcome',
} as const satisfies Record<string, string>;

/** A screen a link or a notice can open first. */
export type FirstScreen = keyof typeof FIRST_SCREEN_EXITS;

/** What the way out needs of Expo Router's `router`. */
export interface LeavingRouter {
    canGoBack(): boolean;
    back(): void;
    replace(href: never): void;
}

/**
 * Leaves `screen`: back `steps` screens when there is one under it (a second step only while there is still one under), else
 * replaces it with its exit ({@link FIRST_SCREEN_EXITS}), or with `fallback` where the screen knows better (a claim with no account
 * left, a door's new account: welcome). Never nothing.
 */
export function leaveScreen(router: LeavingRouter, screen: FirstScreen, opts: { fallback?: string; steps?: number } = {}): void {
    if (!router.canGoBack()) {
        router.replace((opts.fallback ?? FIRST_SCREEN_EXITS[screen]) as never);
        return;
    }
    router.back();
    for (let i = 1; i < (opts.steps ?? 1); i++) {
        if (router.canGoBack()) router.back();
    }
}
