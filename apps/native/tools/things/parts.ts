/**
 * What the Tool shed's phone screens share: the owner's deals, read once a screen opens, a new thing's id, and a write
 * that says whether it was kept. The rules themselves are core's (packages/beanpool-core/src/tools/things/shed.ts).
 */
import { useEffect, useState } from 'react';
import type { ThingsDoc, ThingsScreenProps, ToolDealSummary } from '@beanpool/core';

type Host = ThingsScreenProps['host'];

/**
 * The owner's deals on their own Offers (host.deals), read once when the screen opens: null until they arrive; [] with
 * `failed` when they couldn't be read, so a screen never says "nothing out" for what it couldn't check.
 */
export function useDeals(host: Host): { deals: ToolDealSummary[] | null; failed: boolean } {
    const [state, setState] = useState<{ deals: ToolDealSummary[] | null; failed: boolean }>({ deals: null, failed: false });
    useEffect(() => {
        let gone = false;
        host.deals()
            .then((deals) => { if (!gone) setState({ deals: Array.isArray(deals) ? deals : [], failed: false }); })
            .catch(() => { if (!gone) setState({ deals: [], failed: true }); });
        return () => { gone = true; };
        // Once per screen: the host is rebuilt when its settings change, and the deals don't.
    }, []);
    return state;
}

/** A new thing's id: the time and a few random letters, unique on this phone and any other the member uses. */
export const newThingId = (now: number) => `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** Keep a changed document: true once the host has it, false when it couldn't (the screen says so). */
export async function keep(host: Host, next: ThingsDoc): Promise<boolean> {
    try {
        await host.doc.set(next);
        return true;
    } catch {
        return false;
    }
}
