/**
 * Account Protection's Refresh on the web (recovery without a typed name, slice S4), under a sign-in whose copy this
 * community's server can't find from the sign-in alone yet (@beanpool/core signInsToRefresh, from the member's own status).
 * The phone draws the same row in components/KeeperProtectionPanel.tsx, in the same words, inside that sign-in's own row;
 * here the button names the sign-in ("Refresh your Google copy"), as two of these can sit one under the other.
 *
 * It is the ordinary Connect (lib/link-signin.ts "Refresh"): a nonce, the trip to the provider, and on the way back
 * App.tsx finishes it and Settings shows the result (OneWayBackCard's result line, which says a failure in words). What
 * goes wrong before the trip (no nonce, a sign-in this community gives a browser no id for) is said here, beside the
 * button. Nothing is asked for: no 12 words, no name.
 */
import { useState } from 'react';
import { SIGN_IN_REFRESH_WORDS, t } from '@beanpool/core';
import type { BeanPoolIdentity, JoinProvider } from '../lib/identity';
import { providerLabel } from '../lib/web-join';
import { leaveForLink, requestRefreshNonce } from '../lib/link-signin';
import { keyLineWords } from './key-lines';

interface Props {
    identity: BeanPoolIdentity;
    provider: JoinProvider;
    /** Leaves the page for the provider (swappable in tests). */
    navigate?: (url: string) => void;
    origin?: string;
}

export function RefreshSignIn({ identity, provider, navigate, origin }: Props) {
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);

    async function refresh() {
        if (busy) return;
        setBusy(true);
        setMessage(null);
        const got = await requestRefreshNonce(identity, provider);
        if ('message' in got) {
            setBusy(false);
            setMessage(got.message);
            return;
        }
        const out = leaveForLink(identity, provider, got.nonce, { navigate, origin, purpose: 'refresh' });
        // The page is leaving; only a trip that didn't start comes back here.
        if (!out.ok) {
            setBusy(false);
            setMessage(out.message);
        }
    }

    return (
        <div data-testid={`refresh-sign-in-${provider}`} className="mt-2 min-w-0">
            {/* nature-600 on white and 400 on nature-900, as the line's other sentences (e2e/signin-recovery-check.mjs). */}
            <p className="m-0 text-xs font-normal text-nature-600 dark:text-nature-400 break-words">{t(SIGN_IN_REFRESH_WORDS.line)}</p>
            {/* The button names its sign-in in its own words: two sign-ins to refresh draw two of these blocks in one card,
                and the phone sets each Refresh inside that sign-in's own "Google Connected" row instead. Its text is
                its accessible name, so a screen reader hears what a sighted member reads. */}
            <button type="button" data-testid={`refresh-sign-in-${provider}-start`} disabled={busy} onClick={() => void refresh()}
                className="mt-1.5 min-h-[44px] px-4 py-2 rounded-xl text-sm font-bold bg-transparent text-nature-900 dark:text-white border border-nature-300 dark:border-nature-700 cursor-pointer break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                {busy ? t('One moment…') : t(SIGN_IN_REFRESH_WORDS.label, { provider: providerLabel(provider) })}
            </button>
            {message && (
                <p role="alert" data-testid="refresh-sign-in-problem" className="text-sm text-red-800 dark:text-red-300 mt-2 mb-0 break-words">{keyLineWords(message)}</p>
            )}
        </div>
    );
}
