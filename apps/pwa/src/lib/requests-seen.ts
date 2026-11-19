/**
 * The Message requests row's red dot in the web app (core dm-requests.ts requestsUnseen; Marty, 19 Nov 2026), as the
 * phone's (apps/native/utils/requests-seen.ts): how far the member had opened the requests list, kept in this browser per
 * account. The browser keeps each community's apart already (one address each), as it does the list. Times and a count,
 * nothing of who wrote. No server change.
 */
import { useEffect, useState } from 'react';
import { parseRequestsSeen, requestsSeenNext, requestsUnseen, type RequestsSeen, type RequestsWaiting } from '@beanpool/core';

/** Where one account's mark is kept in this browser. */
export function requestsSeenStoreKey(publicKey: string): string {
    return `beanpool_message_requests_seen:${publicKey.toLowerCase()}`;
}

function readMark(key: string): RequestsSeen | null {
    try {
        return parseRequestsSeen(localStorage.getItem(key));
    } catch {
        return null;
    }
}

/** Whether the row shows its dot. `open`: the requests list shows now, so what waits is seen, and the mark moves up to it. */
export function useRequestsUnseen(publicKey: string, waiting: RequestsWaiting, open: boolean): boolean {
    const key = requestsSeenStoreKey(publicKey);
    const [seen, setSeen] = useState<{ key: string; mark: RequestsSeen | null }>(() => ({ key, mark: readMark(key) }));
    const ready = seen.key === key ? seen : { key, mark: readMark(key) };
    const next = requestsSeenNext(waiting, ready.mark, open);
    const nextText = next ? JSON.stringify(next) : null;
    useEffect(() => {
        if (!next) return;
        setSeen({ key, mark: next });
        try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* a browser that keeps nothing shows the dot again */ }
    }, [key, nextText]);
    return requestsUnseen(waiting, next ?? ready.mark);
}
