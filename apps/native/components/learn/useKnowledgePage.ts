/**
 * Which page of Local knowledge a post route (`/post/[id]`) names, if it names one. A page opens through the same route as a
 * listing (DESIGN-local-knowledge-fable.md amended §2.11), so a Learn row, a bell line and a shared link all land on one place.
 *
 * Read from the phone's copy first (utils/db.ts `knowledge_posts`), then, when the route says it is a page (`kind=knowledge`, as
 * Learn's rows do), from the node by id naming the type: the node leaves a page out of every read that doesn't (§2.3). A route
 * with no `kind` (a pasted link) is looked for in the copy alone, so opening an ordinary listing costs one small local read and no
 * request.
 *
 * The copy is read again when a sync or a pushed change lands, and an open page leaves the screen when it leaves the copy (a
 * take-down, a hide, a pause: review of #3070). A page the copy held and no longer holds is gone; a page that came from the node
 * is gone when the node, asked again, answers without it. A request that fails keeps what is shown: no answer is not "gone".
 * `isPage`: the route names a page (it said so, or a page was found for it), so PostRoute draws "This page isn't in Learn any
 * more" rather than the listing screen once the page has gone.
 */
import { useEffect, useState } from 'react';
import { DeviceEventEmitter } from 'react-native';
import { getKnowledgePost, signedGet } from '../../utils/db';
import type { KnowledgePage } from '../../utils/learn-copy';

export function useKnowledgePage(id: string | undefined, asked: boolean): { page: KnowledgePage | null; settled: boolean; isPage: boolean } {
    const [page, setPage] = useState<KnowledgePage | null>(null);
    const [settled, setSettled] = useState(false);
    const [found, setFound] = useState(false);
    useEffect(() => {
        setPage(null);
        setSettled(false);
        setFound(false);
        if (!id) return;
        let cancelled = false;
        // Where the page on screen came from, and whether the node has said it has no such page (asked once, not again until
        // the copy holds the page). Each read is numbered so an older one's late answer never draws over a newer one's.
        let shown: 'copy' | 'node' | null = null;
        let nodeSaidNone = false;
        let reads = 0;
        const show = (next: KnowledgePage | null, from: 'copy' | 'node' | null) => {
            shown = next ? from : null;
            setPage(next);
            if (next) setFound(true);
            setSettled(true);
        };
        const read = async () => {
            const mine = ++reads;
            const latest = () => !cancelled && mine === reads;
            let held: KnowledgePage | null = null;
            let copyRead = false;
            try {
                held = await getKnowledgePost(id);
                copyRead = true;
            } catch {
                // An unreadable copy is no answer; the node is asked below when the route says it is a page.
            }
            if (!latest()) return;
            if (held) { nodeSaidNone = false; show(held, 'copy'); return; }
            if (asked && !nodeSaidNone) {
                // undefined: the node wasn't reached or didn't answer, which says nothing about the page.
                let answer: KnowledgePage | null | undefined;
                try {
                    const res = await signedGet(`/api/marketplace/posts?type=knowledge&id=${encodeURIComponent(id)}`);
                    if (res.ok) {
                        const rows = await res.json();
                        answer = Array.isArray(rows) ? rows.find((r: any) => r?.id === id && r?.type === 'knowledge') ?? null : undefined;
                    }
                } catch {
                    // Not reachable: settled below with what is shown.
                }
                if (!latest()) return;
                if (answer !== undefined) {
                    nodeSaidNone = answer === null;
                    show(answer, 'node');
                    return;
                }
            }
            // The copy answered without the page it was showing: the sync or a pushed take-down took it out.
            if (copyRead && shown === 'copy') { show(null, null); return; }
            setSettled(true);
        };
        void read();
        const sub = DeviceEventEmitter.addListener('sync_data_updated', () => { void read(); });
        return () => { cancelled = true; sub.remove(); };
    }, [id, asked]);
    return { page, settled, isPage: asked || found };
}
