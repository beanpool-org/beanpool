/**
 * A member's web push in the open app (scratch/fable-design/DESIGN-web-notifications-fable.md §2.2, slice W2): what the app
 * does at each open and with each click on a notification, and nothing else. Nothing here asks the browser or installs a
 * worker: that is the tap's alone (lib/web-push.ts turnOnWebPush).
 *
 * - **At each open** (a member, at the community the app talks to: web-push.ts webPushOrigin): {@link keepWebPushAtOpen}:
 *   a browser turned on here that now blocks notifications, or forgot them, is let go of at the node (DELETE); one still
 *   allowed gives its subscription again. A Tell me kept from the waiting page is never given again: only Turn on makes
 *   this browser the member's.
 * - **A click** brings the signed notice, in the address's fragment (`/app#notice=`, a new tab) or as the worker's message
 *   (`beanpool-notice`, the open tab). {@link openClickedNotice} checks it as the phone's checkTap does and opens it
 *   through the bell's fixed table (components/NeedsYouIcons.tsx goToNoticeTarget), or opens nothing and shows
 *   FORGED_NOTICE_LINE once. The waiting page (`?door=ask`) checks its own (pages/KnockWaitingPage.tsx).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { checkClickedNotice, keepWebPushAtOpen, noticeInHash, readWebPushPin, webPushOrigin } from './web-push';
import { getNodeApiUrl, getPushNoticeDetails } from './api';
import type { BeanPoolIdentity } from './identity';

export const NOTICE_MESSAGE_TYPE = 'beanpool-notice';

/**
 * One click's notice: checked by the key pinned when this browser was turned on, for this account; then where it lands is
 * read from the node (the details, which also take it off the bell) and opened by `go` with the SIGNED kind and the node's
 * details (no string from the push reaches a route). Details the node has forgotten (7 days) land on the kind's tab.
 * Answers `opened`, `forged` (opens nothing) or `none` (no notice, or one only late).
 */
export async function openClickedNotice(
    data: unknown,
    publicKey: string,
    origin: string | null,
    go: (kind: string, data: Record<string, unknown>) => void,
    read: (id: string) => Promise<{ data?: unknown } | null> = getPushNoticeDetails,
): Promise<'opened' | 'forged' | 'none'> {
    const pin = origin ? readWebPushPin(origin, publicKey) : null;
    const check = checkClickedNotice(data, publicKey, pin?.pushKey ?? null);
    if (check.kind !== 'ok') return check.kind;
    const details = await read(check.notice.id).catch(() => null);
    const d = details?.data;
    go(check.notice.kind, d && typeof d === 'object' && !Array.isArray(d) ? d as Record<string, unknown> : {});
    return 'opened';
}

/** At each open and each click, for a member (`identity` with `member` true). Answers whether to show the forged line. */
export function useWebPushMember(
    identity: BeanPoolIdentity | null,
    member: boolean,
    lang: string,
    go: (kind: string, data: Record<string, unknown>) => void,
): { forged: boolean; dismissForged: () => void } {
    const [forged, setForged] = useState(false);
    const goRef = useRef(go);
    goRef.current = go;
    const publicKey = member ? identity?.publicKey ?? null : null;

    useEffect(() => {
        if (!publicKey || !identity) return;
        const origin = webPushOrigin(getNodeApiUrl());
        const handle = (data: unknown) => {
            void openClickedNotice(data, publicKey, origin, (k, d) => goRef.current(k, d)).then((outcome) => {
                if (outcome === 'forged') setForged(true);
            });
        };
        // A click that opened this tab: the notice is in the fragment (never sent to a server). The waiting page reads its own.
        if (new URLSearchParams(window.location.search).get('door') === null) {
            const inHash = noticeInHash(window.location.hash);
            if (inHash !== undefined) {
                try { window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`); } catch { /* the fragment stays */ }
                handle(inHash);
            }
        }
        const container = typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? navigator.serviceWorker : null;
        const onMessage = (e: MessageEvent) => {
            if (e.data && typeof e.data === 'object' && e.data.type === NOTICE_MESSAGE_TYPE) handle(e.data.notice);
        };
        container?.addEventListener('message', onMessage);
        try { container?.startMessages?.(); } catch { /* messages start with the page */ }
        if (origin) void keepWebPushAtOpen(origin, identity, lang);
        return () => container?.removeEventListener('message', onMessage);
        // The language is read at the open; a change of it is given at the next open, as the phone's registration does.
    }, [publicKey]);

    const dismissForged = useCallback(() => setForged(false), []);
    return { forged, dismissForged };
}
