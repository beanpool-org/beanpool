/**
 * Which page of Local knowledge a post route (`/post/[id]`) names, if it names one. A page opens through the same route as a
 * listing (DESIGN-local-knowledge-fable.md amended §2.11), so a Learn row, a bell line and a shared link all land on one place.
 *
 * Read from the phone's copy first (utils/db.ts `knowledge_posts`), then, when the route says it is a page (`kind=knowledge`, as
 * Learn's rows do), from the node by id naming the type: the node leaves a page out of every read that doesn't (§2.3). A route
 * with no `kind` (a pasted link) is looked for in the copy alone, so opening an ordinary listing costs one small local read and no
 * request. The copy is read again when a sync lands.
 */
import { useEffect, useState } from 'react';
import { DeviceEventEmitter } from 'react-native';
import { getKnowledgePost, signedGet } from '../../utils/db';
import type { KnowledgePage } from '../../utils/learn-copy';

export function useKnowledgePage(id: string | undefined, asked: boolean): { page: KnowledgePage | null; settled: boolean } {
    const [page, setPage] = useState<KnowledgePage | null>(null);
    const [settled, setSettled] = useState(false);
    useEffect(() => {
        setPage(null);
        setSettled(false);
        if (!id) return;
        let cancelled = false;
        let fromNode = false;
        const read = async () => {
            try {
                const held = await getKnowledgePost(id);
                if (cancelled) return;
                if (held) { setPage(held); setSettled(true); return; }
            } catch {
                // An unreadable copy is no page; the node is asked below when the route says it is one.
            }
            if (asked && !fromNode) {
                fromNode = true;
                try {
                    const res = await signedGet(`/api/marketplace/posts?type=knowledge&id=${encodeURIComponent(id)}`);
                    if (res.ok) {
                        const rows = await res.json();
                        const row = Array.isArray(rows) ? rows.find((r: any) => r?.id === id && r?.type === 'knowledge') : null;
                        if (!cancelled && row) { setPage(row); setSettled(true); return; }
                    }
                } catch {
                    // Not reachable, or not a page: settled below.
                }
            }
            if (!cancelled) setSettled(true);
        };
        void read();
        const sub = DeviceEventEmitter.addListener('sync_data_updated', () => { void read(); });
        return () => { cancelled = true; sub.remove(); };
    }, [id, asked]);
    return { page, settled };
}
