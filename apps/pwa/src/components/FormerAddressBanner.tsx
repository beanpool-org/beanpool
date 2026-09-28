/**
 * "This community has moved to <address>. Open it there": the web app opened at a BeanPool name its community had
 * before (lib/former-address.ts, lost-name L4). A plain link, never a redirect: the member's key stays in this
 * address's storage, and nothing of it, nor anything signed or in this address's query, goes with the link. Nothing
 * at the community's current address, on a node that names no current one, or on one that can't be asked.
 *
 * At the top of the member's screen, the visitor lobby and the welcome page (App.tsx, GuestLobby.tsx), above the
 * mobile header: on the map that header floats over the page, so the banner sits over it rather than under it.
 */
import { useEffect, useState } from 'react';
import { communityInfoOnce } from '../lib/visitor-lobby-gate';
import { formerAddressNotice, webAppHost, type FormerAddressNotice } from '../lib/former-address';

export function FormerAddressBanner({ signedIn = false }: { signedIn?: boolean }) {
    const [notice, setNotice] = useState<FormerAddressNotice | null>(null);

    useEffect(() => {
        let cancelled = false;
        // The page's one shared read of /api/community/info (the Market reads it too). A node that can't be asked says
        // nothing here, and nothing that fails here, even at once, can take the page down with it.
        Promise.resolve()
            .then(() => communityInfoOnce())
            .then((info) => { if (!cancelled) setNotice(formerAddressNotice(info, webAppHost())); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, []);

    if (!notice) return null;
    return (
        <div
            role="status"
            data-testid="former-address-banner"
            className="relative z-[110] w-full shrink-0 bg-amber-600 dark:bg-amber-700 text-white px-4 py-2.5 text-sm font-medium border-b border-amber-700 dark:border-amber-800 shadow-md"
        >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <p className="m-0 flex-1 min-w-0 basis-48 leading-snug [overflow-wrap:anywhere]">
                    This community has moved to <strong className="font-bold">{notice.primaryAddress}</strong>.
                </p>
                {' '}
                <a
                    href={notice.href}
                    rel="noreferrer"
                    className="inline-flex items-center min-h-[44px] max-w-full px-4 bg-white text-amber-900 font-bold rounded-lg shadow-sm no-underline hover:bg-amber-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-amber-700"
                >
                    Open it there
                </a>
            </div>
            {signedIn && (
                <p className="m-0 mt-1.5 text-amber-50 text-xs sm:text-sm leading-snug">
                    You&apos;ll sign in there again, as you would in a new browser.
                </p>
            )}
        </div>
    );
}
