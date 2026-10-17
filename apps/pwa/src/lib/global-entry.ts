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
 * No lock-in (memory no-domain-lock-in): nothing here asks any server anything. The app's link is offered only where
 * this page IS the community that link opens (BeanPool's own global), so a self-hoster's global keeps its browser join
 * as it was; the Settings row draws only what the node names, and nothing at all when it names none.
 */

import { useEffect, useState } from 'react';
import { audienceOf, t } from '@beanpool/core';
import type { CommunityInfo } from './api';

/** The link the BeanPool app claims (slice P4): the app at the global community's door when installed, else the store. */
export const APP_GLOBAL_LINK = 'https://beanpool.org/global';
/** The community that link opens in the app (apps/native/utils/global-node-url.ts GLOBAL_NODE_URL), as a bare host. */
export const APP_GLOBAL_HOST = 'global.beanpool.org';

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

/** One way in on the lobby's Join card: the app (the smart link), the browser join, or "Already have BeanPool?". */
export type LobbyJoinWay = 'app' | 'browser' | 'have-account';

/**
 * The Join card's ways in, in the order they are drawn. The app comes first only on a phone's browser, at the
 * community the app's link opens, while its door is open: anywhere else that link would open a community this page
 * isn't, or one that turns strangers away.
 */
export function lobbyJoinWays({ phone, appsGlobal, doorOpen }: { phone: boolean; appsGlobal: boolean; doorOpen: boolean }): LobbyJoinWay[] {
    return phone && appsGlobal && doorOpen ? ['app', 'browser', 'have-account'] : ['browser', 'have-account'];
}

/**
 * How to put this account on a phone (design §D), where the 12 words are on screen (`backup`, Safety Backup) or not
 * (`settings`). At the community the app offers by name: choose **Global community**, as the phone's restore lists it.
 * At any other: that community's address, typed with the words, as the phone's restore asks for it. `host` null: no
 * address to give, so no words line. `hasWords` false (a browser restored from a copy without them): no words line
 * either, as nothing in Settings tells such a browser to rely on words it hasn't got (components/SignInRecoveryLine).
 * `signIns`: the sign-ins that bring this account back, as a member reads them ("Google"); null or empty, no sign-in
 * line. Each line marks the buttons' names in **bold** (components/BoldWords).
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
    if (signIns) lines.push(t('If you joined with {provider}, **Recover with Social** works too.', { provider: signIns }));
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
