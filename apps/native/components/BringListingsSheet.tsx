/**
 * Home's Bring my listings sheet (utils/bring-listings.ts): looks for this key's offer each time Home comes to the front,
 * so it comes after the join's profile step, and draws nothing until the listings have been read: a community that
 * can't be reached means no sheet yet, and the offer is kept for a later visit, as it is while a community waits for the
 * member's first Offer. Once the member has said yes, what is left is tried again here with no sheet at all until there
 * is something to say. The run can be closed: it goes on, and says what came of it when it ends.
 *
 * `onQuiet`: said each time Home comes to the front and the sheet has nothing to show, and each time a sheet shown is put
 * away for good (Not now, Done), so what waits for it (the listing a member came for, utils/listing-after-join.ts) opens
 * after it, never under it. Not while the offer, a run that was shown, or its answer is up.
 *
 * Drawn by components/BringListingsSheetView.tsx.
 */
import React, { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { useIdentity } from '../app/IdentityContext';
import { anchorUrl } from '../utils/node-post';
import { beansOn, getCachedNodeProfile } from '../utils/node-profile';
import {
    acceptBringOffer, closeBringOffer, pendingBringOffer, planBring, putOffBringOffer, runBring, settleBringOffer,
    type BringOffer, type BringPlan,
} from '../utils/bring-listings';
import { BringListingsSheetView, type BringStep } from './BringListingsSheetView';

/** How often Home reads two communities for an offer it can't finish. Home comes to the front at every tab change. */
const LOOK_GAP_MS = 5 * 60 * 1000;
/**
 * One look or run at a time on this phone, outside the component: a run goes on when it is closed, so it can outlive a
 * Home that is drawn anew. A second would send the same listings, and the node's refusal of each copy would read as a
 * listing left behind when it had arrived.
 */
let busy = false;

export function BringListingsSheet({ onQuiet }: { onQuiet?: () => void }) {
    const { identity } = useIdentity();
    const quietRef = useRef(onQuiet);
    quietRef.current = onQuiet;
    const quiet = useCallback(() => { quietRef.current?.(); }, []);
    const [view, setView] = useState<BringStep | null>(null);
    const asked = useRef<{ offer: BringOffer; plan: BringPlan } | null>(null);
    const closed = useRef(false);
    const lastLook = useRef(0);

    const run = useCallback(async (offer: BringOffer, plan: BringPlan, shown: boolean) => {
        if (!identity) return;
        busy = true;
        closed.current = false;
        try {
            const onStep = (done: number, total: number) => { if (!closed.current) setView({ step: 'bringing', done, total }); };
            const result = await runBring(offer, plan, identity, shown ? onStep : undefined);
            await settleBringOffer(offer, result);
            if (result.brought > 0) (await import('../services/pillar-sync')).requestSync().catch(() => {});
            const nothingToSay = !shown && (result.kept || (result.brought === 0 && result.lines.length === 0));
            setView(nothingToSay ? null : { step: 'done', name: offer.name, brought: result.brought, lines: result.lines, kept: result.kept });
            if (nothingToSay) quiet();
        } catch {
            // Never left on a sheet with no way out: the offer is as it was, for the next visit.
            setView(null);
            quiet();
        } finally {
            busy = false;
        }
    }, [identity, quiet]);

    useFocusEffect(useCallback(() => {
        let live = true;
        void (async () => {
            const publicKey = identity?.publicKey;
            // A sheet up, or a run going: it says when it is done.
            if (busy || asked.current) return;
            if (!identity || !publicKey) { quiet(); return; }
            const offer = await pendingBringOffer(publicKey, await anchorUrl().catch(() => null)).catch(() => null);
            if (!offer || Date.now() - lastLook.current < LOOK_GAP_MS) { if (live) quiet(); return; }
            lastLook.current = Date.now();
            busy = true;
            let plan: Awaited<ReturnType<typeof planBring>>;
            try {
                plan = await planBring(offer, identity);
            } finally {
                busy = false;
            }
            if (plan === 'unreachable' || plan === 'waiting') { if (live) quiet(); return; }
            if (plan === 'nothing' || (plan.bring.length === 0 && (offer.accepted || plan.gone.length === 0))) {
                await closeBringOffer(publicKey);
                if (live) quiet();
                return;
            }
            // After a yes the question isn't asked again, and the lines about what stayed behind have been said.
            if (offer.accepted) {
                void run(offer, { ...plan, gone: [] }, false);
                return;
            }
            if (!live) return;
            if (plan.bring.length === 0) {
                await closeBringOffer(publicKey);
                setView({ step: 'done', name: offer.name, brought: 0, lines: plan.gone.map((title) => ({ kind: 'gone', title })), kept: false });
                return;
            }
            const noPrice = beansOn((await getCachedNodeProfile(offer.to).catch(() => null))?.features);
            asked.current = { offer, plan };
            setView({ step: 'offer', name: offer.name, count: plan.bring.length, noPrice });
        })().catch(() => {});
        return () => { live = false; };
    }, [identity, run, quiet]));

    if (!view) return null;
    return (
        <BringListingsSheetView
            view={view}
            onBring={() => {
                const now = asked.current;
                asked.current = null;
                if (!now) return;
                setView({ step: 'bringing', done: 0, total: now.plan.bring.length });
                void acceptBringOffer(now.offer).then((offer) => run(offer, now.plan, true)).catch(() => setView(null));
            }}
            onNotNow={() => {
                const now = asked.current;
                asked.current = null;
                setView(null);
                if (now) void putOffBringOffer(now.offer).catch(() => {});
                quiet();
            }}
            onClose={() => {
                closed.current = true;
                // Its answer put away is the end; a run put away still says what came of it when it ends.
                const over = view.step === 'done';
                setView(null);
                if (over) quiet();
            }}
        />
    );
}
