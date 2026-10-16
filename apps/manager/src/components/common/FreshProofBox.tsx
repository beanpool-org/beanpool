import React, { useCallback, useRef, useState } from 'react';
import { FRESH_PROOF_WORDS as W, FreshProofRequiredError, freshProofRefusalOf, t, type FreshProofRefusal } from '../../lib/fresh-proof';

/**
 * An owner's fresh proof on a manager screen (lib/fresh-proof.ts; server admin-auth.ts requireFreshProof). A screen's
 * send function takes an optional code and reports the server's answer to `check` (a Response) or `checkError` (a
 * thrown FreshProofRequiredError). When the server asks the proof, the box opens:
 *   the password viewer   a code field; Confirm re-sends the SAME request once with that code. A wrong or spent code
 *                         keeps the field open with the server's sentence, and Confirm waits for a different code;
 *   the phone viewer      (a stale Manage hand-off) "Press Manage on your phone again…";
 *   the computer viewer   (a key session from "Sign in with your phone") "Do this from your phone…".
 */
export interface FreshProof {
    refusal: FreshProofRefusal | null;
    /** The code the last request carried, so Confirm never re-sends the same one. */
    lastCode: string | undefined;
    busy: boolean;
    /** After a fetch: true when the server asked the proof (the box is open; stop), false otherwise (the box closes). */
    check: (res: Response, retry: (code: string) => Promise<unknown>, sentCode?: string) => Promise<boolean>;
    /** After a thrown error: true when it was the proof (the box is open), false otherwise. */
    checkError: (err: unknown, retry: (code: string) => Promise<unknown>, sentCode?: string) => boolean;
    submit: (code: string) => Promise<void>;
    close: () => void;
}

export function useFreshProof(): FreshProof {
    const [refusal, setRefusal] = useState<FreshProofRefusal | null>(null);
    const [lastCode, setLastCode] = useState<string | undefined>(undefined);
    const [busy, setBusy] = useState(false);
    const retryRef = useRef<((code: string) => Promise<unknown>) | null>(null);

    const open = useCallback((r: FreshProofRefusal | null, retry: (code: string) => Promise<unknown>, sentCode?: string) => {
        setLastCode(sentCode);
        if (r) {
            retryRef.current = retry;
            setRefusal(r);
            return true;
        }
        retryRef.current = null;
        setRefusal(null);
        return false;
    }, []);

    const check = useCallback(async (res: Response, retry: (code: string) => Promise<unknown>, sentCode?: string) =>
        open(await freshProofRefusalOf(res), retry, sentCode), [open]);

    const checkError = useCallback((err: unknown, retry: (code: string) => Promise<unknown>, sentCode?: string) =>
        open(err instanceof FreshProofRequiredError ? err.refusal : null, retry, sentCode), [open]);

    const submit = useCallback(async (code: string) => {
        const retry = retryRef.current;
        if (!retry) return;
        setBusy(true);
        try {
            await retry(code);
        } finally {
            setBusy(false);
        }
    }, []);

    const close = useCallback(() => {
        retryRef.current = null;
        setRefusal(null);
        setLastCode(undefined);
    }, []);

    return { refusal, lastCode, busy, check, checkError, submit, close };
}

export function FreshProofBox({ proof, testId = 'fresh-proof' }: { proof: FreshProof; testId?: string }) {
    const [code, setCode] = useState('');
    const { refusal, lastCode, busy } = proof;
    if (!refusal) return null;

    if (refusal.kind !== 'code') {
        const sentence = refusal.kind === 'phone' ? t(W.phone) : refusal.kind === 'step-up' ? t(W.stepUp) : t(W.needs2fa);
        return (
            <div className="mt-3 p-3 rounded-xl border border-amber-500/40 bg-bp-chip-warn-tint text-sm text-bp-chip-warn-ink break-words"
                role="alert" data-testid={`${testId}-${refusal.kind}`}>
                <p className="m-0">{sentence}</p>
                <button type="button" onClick={proof.close}
                    className="mt-2 text-xs text-nature-300 hover:text-nature-100 underline bg-transparent border-0 p-0 cursor-pointer">
                    {t(W.cancel)}
                </button>
            </div>
        );
    }

    const clean = code.trim();
    const triedThis = lastCode !== undefined && clean === lastCode.trim();
    const canSend = !busy && clean.length >= 6 && !triedThis;
    const send = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!canSend) return;
        await proof.submit(clean);
    };
    return (
        <form onSubmit={send} data-testid={`${testId}-code`}
            className="mt-3 p-3 rounded-xl border border-nature-700 bg-nature-950/60 space-y-2 text-sm min-w-0">
            <p className="m-0 text-nature-200 break-words">{lastCode ? t(W.codeAgain) : (refusal.error || t(W.codeAsk))}</p>
            {lastCode && refusal.error && (
                <p className="m-0 text-xs text-red-300 break-words" role="alert" data-testid={`${testId}-error`}>{refusal.error}</p>
            )}
            <label className="block text-xs text-nature-400" htmlFor={`${testId}-input`}>{t(W.codeLabel)}</label>
            <div className="flex flex-wrap gap-2">
                <input id={`${testId}-input`} data-testid={`${testId}-input`} value={code} autoFocus
                    onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" inputMode="text" maxLength={32}
                    className="flex-1 min-w-[8rem] px-3 py-2 rounded-lg bg-nature-900 border border-nature-700 text-nature-100 font-mono tracking-widest" />
                <button type="submit" disabled={!canSend} data-testid={`${testId}-confirm`}
                    className="min-h-[44px] px-4 py-2 rounded-lg bg-bp-cta-fill hover:bg-bp-cta-hover text-bp-cta-on text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed">
                    {busy ? t(W.checking) : t(W.confirm)}
                </button>
                <button type="button" onClick={proof.close} data-testid={`${testId}-cancel`}
                    className="min-h-[44px] px-3 py-2 rounded-lg border border-nature-700 text-nature-300 text-sm bg-transparent">
                    {t(W.cancel)}
                </button>
            </div>
        </form>
    );
}
