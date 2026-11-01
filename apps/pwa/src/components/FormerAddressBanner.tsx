/**
 * "This community has moved to <address>. Open it there": the web app opened at a BeanPool name its community had
 * before (lib/former-address.ts, lost-name L4). A plain link, never a redirect: the member's key stays in this
 * address's storage, and nothing of it, nor anything signed or in this address's query, goes with the link. Nothing
 * at the community's current address, on a node that names no current one, or on one that can't be asked.
 *
 * At any own address that is not the community's primary address, the web app shows one quiet line: "This community's
 * main address is now <address>. This address keeps working." (Fable design §5).
 *
 * At the top of the member's screen, the visitor lobby and the welcome page (App.tsx, GuestLobby.tsx), above the
 * mobile header: on the map that header floats over the page, so the banner sits over it rather than under it.
 */
import { useEffect, useState } from 'react';
import { t } from '@beanpool/core';
import { communityInfoOnce } from '../lib/visitor-lobby-gate';
import {
    dismissMainAddress,
    formerAddressNotice,
    isMainAddressDismissed,
    nonPrimaryAddressNotice,
    webAppHost,
    type FormerAddressNotice,
    type MainAddressNotice,
} from '../lib/former-address';

export function FormerAddressBanner({ signedIn = false, isGuest = null }: { signedIn?: boolean; isGuest?: boolean | null }) {
    const [formerNotice, setFormerNotice] = useState<FormerAddressNotice | null>(null);
    const [mainNotice, setMainNotice] = useState<MainAddressNotice | null>(null);
    const [dismissed, setDismissed] = useState(false);
    const [showHelp, setShowHelp] = useState(false);

    useEffect(() => {
        let cancelled = false;
        // The page's one shared read of /api/community/info (the Market reads it too). A node that can't be asked says
        // nothing here, and nothing that fails here, even at once, can take the page down with it.
        Promise.resolve()
            .then(() => communityInfoOnce())
            .then((info) => {
                if (cancelled) return;
                const host = webAppHost();
                const former = formerAddressNotice(info, host);
                if (former) {
                    setFormerNotice(former);
                    return;
                }
                const main = nonPrimaryAddressNotice(info, host);
                if (main) {
                    if (isMainAddressDismissed(main.primaryAddress)) {
                        setDismissed(true);
                    }
                    setMainNotice(main);
                }
            })
            .catch(() => {});
        return () => { cancelled = true; };
    }, []);

    if (formerNotice) {
        return (
            <div
                role="status"
                aria-live="polite"
                aria-label={t('Community address change alert')}
                data-testid="former-address-banner"
                className="relative z-[110] w-full shrink-0 bg-bp-gold-fill text-bp-gold-on px-4 py-2.5 text-sm font-medium border-b border-bp-gold-fill shadow-md"
            >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <p className="m-0 flex-1 min-w-0 basis-48 leading-snug [overflow-wrap:anywhere]">
                        {t('This community has moved to {address}.', { address: formerNotice.primaryAddress })}
                    </p>
                    {' '}
                    <a
                        href={formerNotice.href}
                        rel="noreferrer"
                        className="inline-flex items-center min-h-[44px] max-w-full px-4 bg-white text-amber-900 font-bold rounded-lg shadow-sm no-underline hover:bg-amber-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-amber-700"
                    >
                        {t('Open it there')}
                    </a>
                </div>
                {signedIn && (
                    <p className="m-0 mt-1.5 text-xs sm:text-sm leading-snug">
                        {t("You'll sign in there again, as you would in a new browser.")}
                    </p>
                )}
            </div>
        );
    }

    if (mainNotice && isGuest === false && !dismissed) {
        const handleDismiss = () => {
            dismissMainAddress(mainNotice.primaryAddress);
            setDismissed(true);
        };

        return (
            <div
                role="status"
                aria-live="polite"
                aria-label={t('Community address change alert')}
                data-testid="main-address-banner"
                className="relative z-[110] w-full shrink-0 bg-nature-100 dark:bg-nature-900 text-nature-900 dark:text-nature-100 px-4 py-2.5 text-sm font-medium border-b border-nature-200 dark:border-nature-800 shadow-sm"
            >
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                    <p className="m-0 flex-1 min-w-0 basis-full sm:basis-auto leading-snug [overflow-wrap:anywhere]">
                        {t("This community's main address is now {address}. This address keeps working.", { address: mainNotice.primaryAddress })}
                    </p>
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                        <a
                            href={mainNotice.href}
                            rel="noreferrer"
                            className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] px-3 py-1.5 text-xs sm:text-sm font-semibold rounded-lg bg-nature-200 dark:bg-nature-800 text-nature-900 dark:text-nature-100 hover:bg-nature-300 dark:hover:bg-nature-700 no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                        >
                            {t('Open it there')}
                        </a>
                        <button
                            type="button"
                            onClick={() => setShowHelp((h) => !h)}
                            aria-expanded={showHelp}
                            aria-controls="main-address-help"
                            className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] px-3 py-1.5 text-xs sm:text-sm font-semibold rounded-lg bg-transparent border border-nature-300 dark:border-nature-700 text-nature-900 dark:text-nature-100 hover:bg-nature-200/50 dark:hover:bg-nature-800/50 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                        >
                            {t('Link this browser from your phone')}
                        </button>
                        <button
                            type="button"
                            onClick={handleDismiss}
                            aria-label={t('Dismiss')}
                            className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] px-2.5 py-1.5 text-xs sm:text-sm font-medium rounded-lg bg-transparent text-nature-700 dark:text-nature-300 hover:text-nature-900 dark:hover:text-nature-100 hover:bg-nature-200/50 dark:hover:bg-nature-800/50 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                        >
                            {t('Dismiss')}
                        </button>
                    </div>
                </div>
                {showHelp && (
                    <p id="main-address-help" data-testid="main-address-help" className="m-0 mt-2 text-xs sm:text-sm leading-snug text-nature-700 dark:text-nature-300">
                        {t('To use {address} from this browser, the phone must be on {address} first, because a Link a device code is refused when the phone and browser are on different addresses.', { address: mainNotice.primaryAddress })}
                    </p>
                )}
            </div>
        );
    }

    return null;
}
