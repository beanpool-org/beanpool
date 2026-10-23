/**
 * What the Tool shed's web screens share: the owner's deals, read once a screen opens, a new thing's id, and a write that
 * says whether it was kept. The rules themselves are core's (packages/beanpool-core/src/tools/things/shed.ts); the phone's
 * twin is apps/native/tools/things/parts.ts.
 */
import { useEffect, useState } from 'react';
import { shedFits, type ThingsDoc, type ThingsScreenProps, type ToolDealSummary } from '@beanpool/core';

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
        // Once per screen: the host is rebuilt when the page's state changes, and the deals don't.
    }, []);
    return state;
}

/** A new thing's id: the time and a few random letters, unique in this browser and on any phone the member uses. */
export const newThingId = (now: number) => `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** Why a changed document wasn't kept: past the store's bound (the shed is full), or the host couldn't keep it. */
export type NotKept = 'too-big' | 'not-kept';

/**
 * Keep a changed document: null once the host has it, else why not (the screen says which). One past the store's bound
 * (core's shedFits, the bound the host refuses at) is never handed to the host, so the shed is said to be full, never
 * "Try again".
 */
export async function keep(host: Host, next: ThingsDoc): Promise<NotKept | null> {
    if (!shedFits(next)) return 'too-big';
    try {
        await host.doc.set(next);
        return null;
    } catch (e) {
        // The host's own size refusal (ToolDocTooBig in tools/builder.ts), should its bound ever be tighter than core's.
        return e instanceof Error && e.name.startsWith('ToolDocTooBig') ? 'too-big' : 'not-kept';
    }
}

/** A row of buttons that wraps: the web primitives' buttons sit in it. */
export const BUTTONS = 'p-3 flex flex-wrap gap-2 min-w-0';
