/**
 * Settings → Diagnostics compares this phone's count of ledger lines with the node's. The node's count, where it can be
 * had, is the member's own ledger (GET /api/ledger/transactions?publicKey=<me>): their Beans. Where Beans are a preview
 * for this reader (the global node, which draws Example Valley), it is never asked (utils/reads-own.ts; review of
 * #2035), and the compare keeps the node's own count from its info, as when that read fails. Elsewhere, asked as before.
 *
 * The mode is the one the info just read says (`info`, the answer Diagnostics already holds), with the account's own set
 * as the node last answered it: BeanID's verified member reads theirs.
 */
import { readNodeProfile } from './node-profile';
import { readerFeaturesHeld, readerFeaturesKey, readsOwnWith } from './reads-own';

/** The member's own count of ledger lines on the node at `cleanUrl`; null where it is not asked, or the read fails. */
export async function remoteOwnTransactionCount(cleanUrl: string, info: unknown, publicKey: string | null | undefined): Promise<number | null> {
    if (!publicKey) return null;
    const node = readNodeProfile(info)?.features;
    const reader = readerFeaturesHeld.get(readerFeaturesKey(cleanUrl, publicKey))?.features ?? null;
    if (!readsOwnWith('beans', node, reader)) return null;
    try {
        const res = await fetch(`${cleanUrl}/api/ledger/transactions?publicKey=${publicKey}&limit=200&_t=${Date.now()}`);
        if (!res.ok) return null;
        const lines = await res.json();
        return Array.isArray(lines) ? lines.length : null;
    } catch (e) {
        console.warn('[Diagnostics] Failed fetching remote personal transactions count:', e);
        return null;
    }
}
