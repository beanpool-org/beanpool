import React, { useState } from 'react';
import { signOutEverywhere } from '../../lib/node-client';

/**
 * "Sign out everywhere", for the person signed in to Settings with their key (Owners & admins). The node ends every
 * Settings session of theirs, on every computer and phone, and retires a break-glass code made from one of them (#1531).
 * Automation tokens are not sign-ins and keep working (#1563 review): the words send an owner to that card to revoke any
 * token they didn't make. Asks first; on success this browser is signed out too
 * (onSignedOut shows the sign-in screen). Never offered to the password or a fleet profile: they have no key of their own.
 *
 * Operator manual text: packages/beanpool-guide/operators/setup/access-and-security.md — keep the two in step.
 */
export const SIGN_OUT_EVERYWHERE_WARNING =
    'This signs you out of Settings on every computer and phone, and retires a break-glass code made from one of those sign-ins. You will need to sign in again here. Automation tokens are not sign-ins and keep working: if someone else may have signed in as you, check Automation tokens (Access & Security) and revoke any you didn\'t make.';

export function SignOutEverywhere({ onSignedOut }: { onSignedOut: () => void }) {
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const btn = 'min-h-[48px] px-4 rounded-xl text-sm font-semibold border';

    const go = async () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        const res = await signOutEverywhere();
        setBusy(false);
        if (res.ok) {
            setConfirming(false);
            onSignedOut();
            return;
        }
        setError(res.message);
    };

    return (
        <div className="rounded-2xl border border-nature-800 bg-nature-900/60 p-4 space-y-3" data-sign-out-everywhere>
            <h4 className="text-base font-semibold text-nature-100 m-0">Sign out everywhere</h4>
            {!confirming ? (
                <>
                    <p className="text-sm text-nature-300 m-0">Lost a phone, or signed in on a computer that isn&apos;t yours? End all your sign-ins at once.</p>
                    <button type="button" onClick={() => { setError(null); setConfirming(true); }} className={`${btn} bg-nature-800 text-nature-100 border-nature-700`}>
                        Sign out everywhere
                    </button>
                </>
            ) : (
                <div className="space-y-3">
                    <p className="text-sm text-nature-200 m-0">{SIGN_OUT_EVERYWHERE_WARNING}</p>
                    <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => void go()} disabled={busy} className={`${btn} bg-terra-500 text-white border-terra-500`}>
                            {busy ? 'Signing out…' : 'Yes, sign me out everywhere'}
                        </button>
                        <button type="button" onClick={() => { setConfirming(false); setError(null); }} disabled={busy} className={`${btn} bg-nature-800 text-nature-200 border-nature-700`}>
                            Cancel
                        </button>
                    </div>
                </div>
            )}
            {error && <p role="alert" className="text-sm text-red-300 m-0 break-words">{error}</p>}
        </div>
    );
}
