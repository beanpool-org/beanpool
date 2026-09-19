import React, { useCallback, useEffect, useRef, useState } from 'react';
import { buildSettingsSigninQr } from '@beanpool/core';
import { generateOfflineQrUrl } from '../../lib/qr';
import type { KeySession } from '../../lib/key-session';
import {
    startPhonePairing,
    waitForPhone,
    formatCountdown,
    formatShortCode,
    PHONE_SIGNIN_MESSAGES,
    type PhonePairing,
} from '../../lib/phone-signin';

/**
 * "Sign in with your phone": a QR the owner scans with the BeanPool app (lib/phone-signin.ts has the protocol).
 *
 * Shows the QR, the short code to compare with the phone, and a countdown; waits for the phone; a new code comes
 * by itself when one runs out (up to AUTO_RENEWALS times, so a forgotten tab stops asking the node), or on
 * "New code".
 */

/** Ten minutes of fresh codes for an unattended page, then it waits for a click. */
export const AUTO_RENEWALS = 4;
const RETRY_MS = 2_000;
const MIN_POLL_MS = 1_000;

type State =
    | { kind: 'starting' }
    | { kind: 'showing'; pairing: PhonePairing; notice: string | null }
    | { kind: 'ended'; message: string }
    | { kind: 'signed-in' };

interface PhoneSignInProps {
    onSignedIn: (session: KeySession, csrfToken: string) => void;
    onUsePassword: () => void;
}

export function PhoneSignIn({ onSignedIn, onUsePassword }: PhoneSignInProps) {
    const [state, setState] = useState<State>({ kind: 'starting' });
    const [now, setNow] = useState(() => Date.now());
    const renewals = useRef(0);
    const run = useRef(0); // bumps on every new code and on unmount: an older poll loop sees it and stops
    const abort = useRef<AbortController | null>(null);
    const signedIn = useRef(onSignedIn);
    signedIn.current = onSignedIn;

    const newCode = useCallback(async (auto: boolean) => {
        const mine = ++run.current;
        abort.current?.abort();
        const ctl = new AbortController();
        abort.current = ctl;
        if (!auto) renewals.current = 0;
        setState({ kind: 'starting' });

        const started = await startPhonePairing();
        if (run.current !== mine) return;
        if (started.kind === 'error') { setState({ kind: 'ended', message: started.message }); return; }
        const pairing = started.pairing;
        setState({ kind: 'showing', pairing, notice: null });

        while (run.current === mine) {
            const asked = Date.now();
            const res = await waitForPhone(pairing.pairingId, ctl.signal);
            if (run.current !== mine) return;
            switch (res.kind) {
                case 'waiting':
                    if (res.notice === 'not-admin') setState({ kind: 'showing', pairing, notice: PHONE_SIGNIN_MESSAGES.notAdmin });
                    // The node holds a poll open for up to 25 s. One answered at once (a proxy that won't hold
                    // a request) must not turn into a tight loop.
                    if (Date.now() - asked < MIN_POLL_MS) await new Promise(r => setTimeout(r, MIN_POLL_MS));
                    continue;
                case 'retry':
                    if (Date.now() > pairing.expiresAt) break; // treat as expired below
                    await new Promise(r => setTimeout(r, RETRY_MS));
                    continue;
                case 'signed-in':
                    run.current++;
                    setState({ kind: 'signed-in' });
                    signedIn.current(res.session, res.csrfToken);
                    return;
                case 'ended':
                    setState({ kind: 'ended', message: res.message });
                    return;
                case 'expired':
                    break;
            }
            // Expired (or the node stopped answering after the code ran out).
            if (renewals.current < AUTO_RENEWALS) {
                renewals.current++;
                void newCode(true);
            } else {
                setState({ kind: 'ended', message: 'The code expired. Get a new code when you have your phone ready.' });
            }
            return;
        }
    }, []);

    useEffect(() => {
        void newCode(false);
        return () => { run.current++; abort.current?.abort(); };
    }, [newCode]);

    useEffect(() => {
        if (state.kind !== 'showing') return;
        const t = setInterval(() => setNow(Date.now()), 1000);
        setNow(Date.now());
        return () => clearInterval(t);
    }, [state.kind]);

    // The page's own origin, not a configured URL: the pairing and its cookie live where this page's requests go.
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const qr = state.kind === 'showing'
        ? generateOfflineQrUrl(buildSettingsSigninQr({ nodeUrl: origin, pairingId: state.pairing.pairingId, shortCode: state.pairing.shortCode }))
        : '';
    const left = state.kind === 'showing' ? state.pairing.expiresAt - now : 0;

    return (
        <section aria-labelledby="phone-signin-title" className="space-y-4" data-testid="phone-signin">
            <div>
                <h3 id="phone-signin-title" className="text-base font-bold text-white m-0">Sign in with your phone</h3>
                <p className="text-sm text-nature-300 m-0 mt-1 leading-relaxed">
                    In the BeanPool app, open <strong className="text-nature-100">Settings → Sign in on a computer</strong> and scan this code.
                    Owners, admins and moderators only.
                </p>
            </div>

            {state.kind === 'starting' && (
                <div role="status" className="text-sm text-nature-300 py-8 text-center">Getting a code…</div>
            )}

            {state.kind === 'showing' && (
                <>
                    <div className="flex justify-center">
                        {/* White quiet zone, and never wider than the card: a 320px screen still scans. */}
                        <img
                            src={qr}
                            alt={`Sign-in QR code. Short code ${formatShortCode(state.pairing.shortCode)}`}
                            className="w-full max-w-[240px] aspect-square rounded-xl bg-white p-2"
                            data-testid="phone-signin-qr"
                        />
                    </div>
                    <div className="text-center">
                        <div className="text-xs font-bold text-nature-400 uppercase tracking-wider">Check your phone shows</div>
                        <div className="text-2xl font-black text-white font-mono tracking-widest mt-1" data-testid="phone-signin-code">
                            {formatShortCode(state.pairing.shortCode)}
                        </div>
                        {/* Only the words are live: a ticking countdown would be read out every second. */}
                        <div className="text-sm text-nature-300 mt-2" data-testid="phone-signin-status">
                            <span aria-live="polite">Waiting for your phone…</span>{' '}
                            <span className="whitespace-nowrap">code changes in {formatCountdown(left)}</span>
                        </div>
                    </div>
                    {state.notice && (
                        <div role="alert" className="p-3.5 rounded-xl bg-red-950/70 border border-red-800/60 text-red-200 text-sm">
                            {state.notice}
                        </div>
                    )}
                </>
            )}

            {state.kind === 'ended' && (
                <div role="alert" className="p-3.5 rounded-xl bg-red-950/70 border border-red-800/60 text-red-200 text-sm">
                    {state.message}
                </div>
            )}

            {state.kind === 'signed-in' && (
                <div role="status" className="text-sm text-emerald-300 py-4 text-center">Signed in. Opening Settings…</div>
            )}

            {state.kind !== 'signed-in' && (
                <div className="flex flex-wrap gap-3">
                    <button
                        type="button"
                        onClick={() => void newCode(false)}
                        disabled={state.kind === 'starting'}
                        className="flex-1 min-w-[8rem] min-h-[48px] px-4 rounded-xl bg-nature-800 hover:bg-nature-700 text-white font-semibold text-sm disabled:opacity-50"
                    >
                        New code
                    </button>
                    <button
                        type="button"
                        onClick={onUsePassword}
                        className="flex-1 min-w-[8rem] min-h-[48px] px-4 rounded-xl border border-nature-700 text-nature-200 hover:text-white font-semibold text-sm"
                    >
                        Use the password
                    </button>
                </div>
            )}
        </section>
    );
}
