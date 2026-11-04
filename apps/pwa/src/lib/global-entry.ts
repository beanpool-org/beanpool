/**
 * The global community, from the web app (scratch/global-node/DESIGN-global-entry-fable.md §B.3 "On the web", §D and
 * slice W1; Marty took every pick on 17 Oct 2026):
 *
 * - On a phone's browser, at the community the BeanPool app's link opens, the lobby's Join card offers the app first
 *   (the smart link), and "or join here in your browser" second (decision 3). On a computer, the browser as before.
 * - A member who joined here is told how to put the SAME account on a phone: restore it with the 12 words or the
 *   sign-in. Never "I'm new" there, which makes a second account that can never be merged with this one.
 * - Settings on a local community's web app links the global community its node names (`globalCommunityUrl`).
 *
 * No lock-in (memory no-domain-lock-in): nothing here asks any server anything. At BeanPool's own global the app's link is
 * the smart link (beanpool.org/global). At a self-hoster's open community it is that community's OWN address in the app's
 * door link (issue #2563, openDoorAppDoors), with only a public store listing beside it: nothing signed, nothing of ours.
 * A page that is neither keeps its browser join; the Settings row draws only what the node names, and nothing at all when
 * it names none.
 */

import { useEffect, useState } from 'react';
import { audienceOf, shouldBlockCleartextNodeUrl, t } from '@beanpool/core';
import type { AppStoreVersions, CommunityInfo } from './api';
import { isVersionOlder, normaliseVersion } from './app-version';
import { ANDROID_PACKAGE, APP_STORE_URL, PLAY_URL } from './peek';

/** The link the BeanPool app claims (slice P4): the app at the global community's door when installed, else the store. */
export const APP_GLOBAL_LINK = 'https://beanpool.org/global';
/** The community that link opens in the app (apps/native/utils/global-node-url.ts GLOBAL_NODE_URL), as a bare host. */
export const APP_GLOBAL_HOST = 'global.beanpool.org';
/**
 * The first iOS version with the global door (slice S14). S14's flip PR deletes this gate once the App Store build has it.
 */
export const IOS_GLOBAL_DOOR_FROM = '1.2.56';
/**
 * The first iOS version that joins a phone with NO BeanPool account at another community's open door (first account
 * without global, slice S2, #2564: merged 29 Oct, first in 1.2.84). An older App Store build opens that door for an account
 * already on the phone only, so the lobby of a self-hoster's community offers the app on an iPhone from this version on.
 */
export const IOS_OPEN_DOOR_FROM = '1.2.84';

/** A phone's browser: a touch screen for its main pointer, and narrower than the sidebar's breakpoint (Tailwind md). */
export const PHONE_BROWSER_QUERY = '(pointer: coarse) and (max-width: 767px)';

type MediaWindow = { matchMedia?: (query: string) => MediaQueryList };

/** Whether this is a phone's browser (PHONE_BROWSER_QUERY). A browser that can't say: no, so it gets the browser join. */
export function isPhoneBrowser(win: MediaWindow | undefined = typeof window !== 'undefined' ? window : undefined): boolean {
    try {
        return win?.matchMedia?.(PHONE_BROWSER_QUERY)?.matches === true;
    } catch {
        return false;
    }
}

/** isPhoneBrowser, kept as the browser changes its answer (a phone turned on its side, a window resized). */
export function usePhoneBrowser(): boolean {
    const [phone, setPhone] = useState(() => isPhoneBrowser());
    useEffect(() => {
        let list: MediaQueryList | undefined;
        try { list = window.matchMedia?.(PHONE_BROWSER_QUERY); } catch { return; }
        if (!list || typeof list.addEventListener !== 'function') return;
        const changed = () => setPhone(isPhoneBrowser());
        list.addEventListener('change', changed);
        return () => list!.removeEventListener('change', changed);
    }, []);
    return phone;
}

/**
 * Whether this page is the community the app's link opens: the host it was opened at, or one of the names its node
 * publishes (`addresses`, `primaryAddress`), is APP_GLOBAL_HOST.
 */
export function isAppsGlobal(info: Pick<CommunityInfo, 'addresses' | 'primaryAddress'> | null | undefined, host: string | null): boolean {
    if (host === APP_GLOBAL_HOST) return true;
    if (!info) return false;
    return info.primaryAddress === APP_GLOBAL_HOST || (Array.isArray(info.addresses) && info.addresses.includes(APP_GLOBAL_HOST));
}

/**
 * Detect iPhone, iPad, or iPod browsers.
 * Grep in apps/pwa: uses the user-agent check matching InstallPrompt.tsx and invite-trampoline.ts.
 */
export function isIOS(nav: Pick<Navigator, 'userAgent'> | undefined = typeof navigator !== 'undefined' ? navigator : undefined): boolean {
    if (!nav?.userAgent) return false;
    const ua = nav.userAgent;
    return (/iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && !/Chrome|Chromium/.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document)) && !(typeof window !== 'undefined' && 'MSStream' in window);
}

/** One way in on the lobby's Join card: the app (the smart link), the browser join, or "Already have BeanPool?". */
export type LobbyJoinWay = 'app' | 'browser' | 'have-account';

export interface LobbyJoinWaysOptions {
    phone: boolean;
    appsGlobal: boolean;
    doorOpen: boolean;
    /**
     * This page is another community (a self-hoster's) whose open door the app can open at its own address
     * ({@link openDoorAppDoors} found a link for this phone). Read only where the page isn't the app's global.
     */
    ownDoorLink?: boolean;
    platform?: string | null;
    appVersions?: AppStoreVersions | null;
}

/**
 * The Join card's ways in, in the order they are drawn. The app comes first only on a phone's browser, while the door is
 * open, and only where there is a link that opens THIS community: at the community the app's link opens, or at another
 * community's own address ({@link openDoorAppDoors}, slice S2's door). Anywhere else that link would open a community this
 * page isn't, or one that turns strangers away.
 *
 * S14 gate: on an iPhone/iPad browser, offer 'app' only when the community's health appVersions.ios is at least
 * IOS_GLOBAL_DOOR_FROM (at the app's global; earlier App Store builds, e.g. 1.2.31, have no global door) or
 * IOS_OPEN_DOOR_FROM (at another community's door, which an account-less phone joins only from S2). S14's flip PR deletes
 * the first gate once the App Store build has it.
 */
export function lobbyJoinWays({
    phone,
    appsGlobal,
    doorOpen,
    ownDoorLink = false,
    platform,
    appVersions,
}: LobbyJoinWaysOptions): LobbyJoinWay[] {
    if (!phone || !doorOpen || !(appsGlobal || ownDoorLink)) {
        return ['browser', 'have-account'];
    }

    const isIos = platform ? platform.toLowerCase() === 'ios' : isIOS();
    if (isIos) {
        const iosVer = normaliseVersion(appVersions?.ios);
        if (!iosVer || isVersionOlder(iosVer, appsGlobal ? IOS_GLOBAL_DOOR_FROM : IOS_OPEN_DOOR_FROM)) {
            return ['browser', 'have-account'];
        }
    }

    return ['app', 'browser', 'have-account'];
}

/** The app's way into another community's open door, from this page, and the store listing for a phone without the app. */
export interface OpenDoorAppDoors {
    /** Opens the app at that community's door; on Android falls back to Google Play by itself when the app isn't installed. */
    app: string;
    /** The app's public store listing for this phone: the fallback an iPhone needs, since a scheme link to no app opens nothing. */
    store: string;
    platform: 'android' | 'ios';
}

/**
 * The app at THIS community's open door (first account without global, slice S2; issue #2563), for a self-hoster's lobby:
 * `beanpool://join-open-door?node=<this page's own address>`, the door link apps/native/utils/open-door.ts reads. It names
 * the community by the address the visitor is already at and carries nothing else: no key, no signature, no token, no
 * invite and nothing of ours (no beanpool.org, no BeanPool server); the app asks the community itself for its name, and
 * joins only on the member's tap. The only other address in it is a public store listing (peek.ts), the Play fallback on
 * Android as the peek link has it. Built like peekAppDoors: on Android by intent, with Google Play as its fallback; on an
 * iPhone by the scheme, with the App Store beside it.
 *
 * Null (no offer, the browser join as before) where `origin` is not a plain address the phone will reach (no path, query
 * or login in it; cleartext only to a private address, the phone's own rule), or the phone is neither an Android nor an
 * iPhone.
 */
export function openDoorAppDoors(
    origin: string | null | undefined,
    ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : '',
): OpenDoorAppDoors | null {
    if (!origin) return null;
    let url: URL;
    try { url = new URL(origin); } catch { return null; }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname || url.username || url.password
        || url.search || url.hash || url.pathname !== '/') return null;
    if (shouldBlockCleartextNodeUrl(url.origin)) return null;
    const query = `node=${encodeURIComponent(url.origin)}`;
    if (/\bAndroid\b/i.test(ua)) {
        return {
            app: `intent://join-open-door?${query}#Intent;scheme=beanpool;package=${ANDROID_PACKAGE};S.browser_fallback_url=${encodeURIComponent(PLAY_URL)};end`,
            store: PLAY_URL,
            platform: 'android',
        };
    }
    if (/\b(iPhone|iPad|iPod)\b/i.test(ua)) return { app: `beanpool://join-open-door?${query}`, store: APP_STORE_URL, platform: 'ios' };
    return null;
}

/**
 * How to put this account on a phone (design §D), where the 12 words are on screen (`backup`, Safety Backup) or not
 * (`settings`). At the community the app offers by name: choose **Global community**, as the phone's restore lists it.
 * At any other: that community's address, typed with the words, as the phone's restore asks for it (`host`, with the
 * port it is served on when that isn't the scheme's own: lib/former-address.ts webAppAddress). `host` null: no
 * address to give, so no words line. `hasWords` false (a browser restored from a copy without them): no words line
 * either, as nothing in Settings tells such a browser to rely on words it hasn't got (components/SignInRecoveryLine).
 * `signIns`: the sign-ins that bring this account back, as a member reads them ("Google"); null or empty, no sign-in
 * line. Under the words line, the sign-in's is a short "works too". With no words line it stands alone, as the whole
 * way onto a phone (review 4302869392): the app, **Already a member**, **Recover with Social**, the sign-in, and at
 * any community but the app's global its address, as the phone asks for it after the sign-in (apps/native welcome.tsx
 * ssoRecover fills in the global community). No address to give there: no line, as for the words. Each line marks the
 * buttons' names in **bold** (components/BoldWords).
 */
export function phoneLaterLines({ where, appsGlobal, host, hasWords = true, signIns }: {
    where: 'backup' | 'settings';
    appsGlobal: boolean;
    host: string | null;
    hasWords?: boolean;
    signIns: string | null;
}): string[] {
    const lines: string[] = [];
    if (hasWords && appsGlobal) {
        lines.push(where === 'backup'
            ? t('To use BeanPool on your phone later: install the app, tap **Already a member**, choose **Global community** and type these 12 words.')
            : t('To use BeanPool on your phone later: install the app, tap **Already a member**, choose **Global community** and type your 12 words.'));
    } else if (hasWords && host) {
        lines.push(where === 'backup'
            ? t("To use BeanPool on your phone later: install the app, tap **Already a member** and type these 12 words and this community's address, {address}.", { address: host })
            : t("To use BeanPool on your phone later: install the app, tap **Already a member** and type your 12 words and this community's address, {address}.", { address: host }));
    }
    if (!signIns) return lines;
    if (lines.length > 0) {
        lines.push(t('If you joined with {provider}, **Recover with Social** works too.', { provider: signIns }));
    } else if (appsGlobal) {
        lines.push(t('To use BeanPool on your phone later: install the app, tap **Already a member**, then **Recover with Social** and sign in with {provider}.', { provider: signIns }));
    } else if (host) {
        lines.push(t("To use BeanPool on your phone later: install the app, tap **Already a member**, then **Recover with Social**, sign in with {provider} and type this community's address, {address}.", { provider: signIns, address: host }));
    }
    return lines;
}

/**
 * The Settings row "Global community" (design §B.3): the worldwide community this node names for its members
 * (`globalCommunityUrl` in GET /api/community/info, the operator's GLOBAL_COMMUNITY_URL), on a local community only.
 * Null when the node names none (switched off, or a node older than the field), names something that isn't an https
 * address, or names itself; and on a global community, which is it.
 */
export function globalCommunityLink(
    info: Pick<CommunityInfo, 'profile' | 'globalCommunityUrl' | 'addresses'> | null | undefined,
    host: string | null,
): { href: string; host: string } | null {
    if (!info || info.profile === 'global') return null;
    const named = info.globalCommunityUrl;
    if (typeof named !== 'string') return null;
    let url: URL;
    try { url = new URL(named); } catch { return null; }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
    const globalHost = audienceOf(url.origin);
    if (!globalHost || globalHost === host || (Array.isArray(info.addresses) && info.addresses.includes(globalHost))) return null;
    return { href: `${url.origin}/`, host: globalHost };
}
