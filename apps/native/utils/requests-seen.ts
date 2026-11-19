/**
 * The Message requests row's red dot on the phone (core dm-requests.ts requestsUnseen; Marty, 19 Nov 2026): how far the
 * member had opened the requests list, kept per account and community file (storage-keys.ts messageRequestsSeenStoreKey),
 * as the list itself is. No server change: the node's request times and this phone's own copies say all it needs.
 */
import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { parseRequestsSeen, requestsSeenNext, requestsUnseen, type RequestsSeen, type RequestsWaiting } from '@beanpool/core';
import { messageRequestsSeenStoreKey } from './storage-keys';
import { getDatabaseFilenameForNode } from './nodes';

/**
 * Whether the row shows its dot, for `publicKey` in the community at `nodeUrl` (the one the phone is set to). `open`: the
 * requests list shows now, so what waits is seen, and the mark moves up to it. Before the mark is read there is no dot, so
 * the row doesn't flash one on every visit.
 */
export function useRequestsUnseen(publicKey: string | null | undefined, nodeUrl: string | null | undefined, waiting: RequestsWaiting, open: boolean): boolean {
    const key = publicKey && nodeUrl ? messageRequestsSeenStoreKey(publicKey, getDatabaseFilenameForNode(nodeUrl)) : null;
    const [seen, setSeen] = useState<{ key: string; mark: RequestsSeen | null } | null>(null);
    useEffect(() => {
        let alive = true;
        setSeen(null);
        if (!key) return;
        AsyncStorage.getItem(key)
            .catch(() => null)
            .then((raw) => { if (alive) setSeen({ key, mark: parseRequestsSeen(raw) }); });
        return () => { alive = false; };
    }, [key]);
    const ready = seen && seen.key === key ? seen : null;
    const next = ready ? requestsSeenNext(waiting, ready.mark, open) : null;
    const nextText = next ? JSON.stringify(next) : null;
    useEffect(() => {
        if (!ready || !next) return;
        setSeen({ key: ready.key, mark: next });
        AsyncStorage.setItem(ready.key, JSON.stringify(next)).catch(() => {});
    }, [ready?.key, nextText]);
    if (!ready) return false;
    return requestsUnseen(waiting, next ?? ready.mark);
}
