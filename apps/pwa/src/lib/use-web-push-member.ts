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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    checkClickedNotice, keepWebPushAtOpen, laterFromAsk, markNotifyAskHere, noticeInHash, notifyOnceDueHere, readWebPushPin, turnOnAsk, webPushOrigin,
    type PushEnv, type WebPushFailure,
} from './web-push';
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
        // Nor one from a community this member asked from here (`?knock=`, lib/knock-landing.ts): checked by that community's key.
        const params = new URLSearchParams(window.location.search);
        if (params.get('door') === null && !params.has('knock')) {
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

/**
 * Home's once card (scratch/fable-design/DESIGN-notify-and-backup-asks-fable-amend2.md §7, slice N5a; the phone's N1h):
 * the join's ask, once, for a member who never met the join's screen in this browser, by core's own rule (notifyAsks
 * `once`, read through lib/web-push.ts notifyOnceDueHere): first on a free day, then at each landing until Later or for 7
 * days; only where web push reaches this browser, it can still ask, and this account's notifications are not on here.
 * Never where the browser blocks the site or can't be told.
 *
 * Decided as Home lands for this key (`landed`), and kept for that landing after an answer, so the way-back card waits for
 * the next landing: never both on one screen, this one first. Marked shown only once Home has drawn it (`drawn`). Nothing
 * asks the browser until Turn on: its prompt only inside that tap (turnOnFromAsk). A subscription the community did not
 * take keeps the card, saying so.
 */
export function useNotifyOnce(identity: BeanPoolIdentity | null, publicKey: string | null, lang: string, drawn: boolean, env?: PushEnv) {
    // Read once for each key's landing: an answer made here changes the record, never this landing's decision.
    const landed = useMemo(() => !!publicKey && notifyOnceDueHere(publicKey, env), [publicKey]);
    const [answered, setAnswered] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState<WebPushFailure | null>(null);
    const open = landed && answered !== publicKey;

    useEffect(() => {
        if (open && drawn && publicKey) markNotifyAskHere(publicKey, { type: 'shown', surface: 'once' });
    }, [open, drawn, publicKey]);

    const turnOn = () => {
        if (!identity || !publicKey || busy) return;
        setBusy(true);
        setFailed(null);
        void turnOnAsk(identity, lang, 'once', env).then((r) => {
            setBusy(false);
            if (r.result === 'failed') setFailed(r.failure);
            else setAnswered(publicKey);
        });
    };
    const later = () => {
        if (!publicKey) return;
        laterFromAsk(publicKey, 'once');
        setAnswered(publicKey);
    };
    return { landed, open, busy, failed, turnOn, later };
}
