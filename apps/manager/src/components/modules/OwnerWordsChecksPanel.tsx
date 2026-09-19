/**
 * Backups & Restore → "Owners' 12 words" (sealed-keys.md §7, slice 7): for each owner, "12 words checked: <date>" or
 * "not yet".
 *
 * An owner checks their words in the BeanPool app, on their own device, and the app sends a signed statement that
 * they did (POST /api/node/owner/words-check). The server cannot see or verify the words, so this list says what each
 * owner reported and when, never that the server checked anything. It gates nothing.
 *
 * SEAM: this belongs in the "Who can unlock this community" card (TakeoverLockPanel, sealed keys 2b, PR #979), next to
 * each owner in its recipient list. #979 was not on main when this was built, so it stands alone just above where that
 * card goes. Once both are in, fold these rows into that card's owner rows and delete this panel.
 */
import { useCallback, useEffect, useState } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { getOwnerWordsChecks, getTfaSessionToken, type OwnerWordsCheck } from '../../lib/node-client';

export function formatWordsChecked(ms: number | null): string {
    if (!ms) return 'not yet';
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** A year after an owner's last check, the app asks them again; the list says so too. */
const RENEW_MS = 365 * 24 * 60 * 60 * 1000;

export function OwnerWordsChecksPanel({ activeNode, now = Date.now() }: { activeNode: NodeProfile; now?: number }) {
    const [owners, setOwners] = useState<OwnerWordsCheck[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const tfa = getTfaSessionToken(activeNode.id);
            const res = await getOwnerWordsChecks(activeNode.url, activeNode.adminPassword, tfa);
            setOwners(Array.isArray(res.owners) ? res.owners : []);
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, [activeNode.id, activeNode.url, activeNode.adminPassword]);

    useEffect(() => { void load(); }, [load]);

    if (error) {
        // An older server without the route, or a moderator's session: say nothing rather than alarm.
        return null;
    }
    if (!owners) return null;

    const checked = owners.filter((o) => o.wordsCheckedAt && now - o.wordsCheckedAt < RENEW_MS).length;

    return (
        <div className="p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-3" data-testid="owner-words-checks">
            <h3 className="text-base font-bold text-white m-0 flex items-center gap-2 break-words">
                🔑 Owners&apos; 12 words
            </h3>
            <p className="text-sm text-nature-300 m-0 leading-relaxed">
                If an owner loses their phone, their 12 words are how they could still take over the server or open a
                locked backup. Each owner checks theirs in the BeanPool app, on their own device; this shows what they
                reported. The words never reach this server.
            </p>
            {owners.length === 0 ? (
                <p className="text-sm text-nature-400 m-0">This community has no owner yet.</p>
            ) : (
                <>
                    <p className={`text-sm font-semibold m-0 ${checked === owners.length ? 'text-emerald-300' : 'text-amber-300'}`} data-testid="owner-words-summary">
                        {checked} of {owners.length} owner{owners.length === 1 ? ' has' : 's have'} checked their 12 words in the last year.
                        {checked < owners.length ? ' The app asks the others; nothing is blocked.' : ''}
                    </p>
                    <ul className="m-0 p-0 list-none space-y-2">
                        {owners.map((o) => {
                            const stale = !!o.wordsCheckedAt && now - o.wordsCheckedAt >= RENEW_MS;
                            return (
                                <li key={o.pubkey} className="text-sm text-nature-200 break-words min-h-[24px]">
                                    👑 @{o.callsign}
                                    <span className="text-nature-400"> · 12 words checked: </span>
                                    <strong className={o.wordsCheckedAt && !stale ? 'text-emerald-300' : 'text-amber-300'}>
                                        {formatWordsChecked(o.wordsCheckedAt)}
                                    </strong>
                                    {stale && <span className="text-amber-300"> (over a year ago)</span>}
                                </li>
                            );
                        })}
                    </ul>
                </>
            )}
        </div>
    );
}
