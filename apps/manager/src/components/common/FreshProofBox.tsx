import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { FRESH_PROOF_WORDS as W, freshProofRefusalOf, isSecondFactorAsk, isSecondFactorAskOf, refusalOf, t, type FreshProofRefusal } from '../../lib/fresh-proof';

/**
 * An owner's fresh proof on a manager screen (lib/fresh-proof.ts; server admin-auth.ts requireFreshProof). A screen's
 * send function takes an optional code and reports the server's answer to `check` (a Response) or `checkError` (a
 * thrown FreshProofRequiredError). When the server asks the proof, the box opens:
 *   the password viewer   a code field; Confirm re-sends the SAME request once with that code. A wrong or spent code
 *                         keeps the field open with the server's sentence, and Confirm waits for a different code;
 *   the phone viewer      (a stale Manage hand-off) "Press Manage on your phone again…";
 *   the computer viewer   (a key session from "Sign in with your phone") "Do this from your phone…".
 * The box opens EMPTY every time and its field is emptied when it closes, so a code once typed is never offered for a
 * second request (opus-2028 B4). On opening it scrolls itself into view and takes focus, wherever the screen put it
 * (opus-2028 B1): the button pressed may be a screen away.
 */
export interface FreshProof {
    refusal: FreshProofRefusal | null;
    /** The code the last request carried, so Confirm never re-sends the same one. */
    lastCode: string | undefined;
    /** What is typed in the box now: emptied whenever the box opens or closes. */
    code: string;
    setCode: (code: string) => void;
    /** Counts the box's openings (none → a refusal, or one kind to another): the box scrolls and focuses on each. */
    opened: number;
    busy: boolean;
    /** After a fetch: true when the server asked the proof (the box is open; stop), false otherwise (the box closes). */
    check: (res: Response, retry: (code: string) => Promise<unknown>, sentCode?: string) => Promise<boolean>;
    /** After a thrown error: true when it was the proof (the box is open), false otherwise. */
    checkError: (err: unknown, retry: (code: string) => Promise<unknown>, sentCode?: string) => boolean;
    submit: (code: string) => Promise<void>;
    close: () => void;
}

/**
 * The fleet manager's 2FA prompt (App.tsx promptForTotp), for a request refused because the 4-hour 2FA session ended:
 * that 401 is checkAdminAuth's own, not the fresh proof, and a code typed in the box would never reach it (opus-2028 N4).
 * Single-node Settings provides none: its sign-in is a session cookie.
 */
export const SecondFactorPromptContext = createContext<(() => void) | undefined>(undefined);

export function useFreshProof(): FreshProof {
    const [refusal, setRefusal] = useState<FreshProofRefusal | null>(null);
    const [lastCode, setLastCode] = useState<string | undefined>(undefined);
    const [code, setCode] = useState('');
    const [opened, setOpened] = useState(0);
    const [busy, setBusy] = useState(false);
    const retryRef = useRef<((code: string) => Promise<unknown>) | null>(null);
    /** The kind on screen now, read synchronously (a retry's answer arrives in the same tick as the click). */
    const kindRef = useRef<FreshProofRefusal['kind'] | null>(null);
    const askSecondFactor = useContext(SecondFactorPromptContext);

    const open = useCallback((r: FreshProofRefusal | null, retry: (code: string) => Promise<unknown>, sentCode?: string) => {
        setLastCode(sentCode);
        if (r) {
            retryRef.current = retry;
            if (kindRef.current !== r.kind) {
                // Opening (or a different ask): an empty field, and the box comes into view.
                setCode('');
                setOpened((n) => n + 1);
            }
            kindRef.current = r.kind;
            setRefusal(r);
            return true;
        }
        retryRef.current = null;
        kindRef.current = null;
        setRefusal(null);
        setCode('');
        return false;
    }, []);

    const check = useCallback(async (res: Response, retry: (code: string) => Promise<unknown>, sentCode?: string) => {
        if (await isSecondFactorAskOf(res)) askSecondFactor?.();
        return open(await freshProofRefusalOf(res), retry, sentCode);
    }, [open, askSecondFactor]);

    const checkError = useCallback((err: unknown, retry: (code: string) => Promise<unknown>, sentCode?: string) => {
        if (isSecondFactorAsk(err)) askSecondFactor?.();
        return open(refusalOf(err), retry, sentCode);
    }, [open, askSecondFactor]);

    const submit = useCallback(async (typed: string) => {
        const retry = retryRef.current;
        if (!retry) return;
        setBusy(true);
        try {
            await retry(typed);
        } finally {
            setBusy(false);
        }
    }, []);

    const close = useCallback(() => {
        retryRef.current = null;
        kindRef.current = null;
        setRefusal(null);
        setLastCode(undefined);
        setCode('');
    }, []);

    return { refusal, lastCode, code, setCode, opened, busy, check, checkError, submit, close };
}

/** Bring a just-opened box into view and give it focus: the whole box (its sentence too), not only the field. */
function showOpened(box: HTMLElement, focus: HTMLElement) {
    // In a modal or wizard the box goes to the top of the overlay, clear of the phone's keyboard; on a page, the least
    // scrolling that shows it whole.
    const inModal = Boolean(box.closest('[data-bp-modal]'));
    box.scrollIntoView?.({ block: inModal ? 'start' : 'nearest', inline: 'nearest' });
    focus.focus({ preventScroll: true });
}

/** `onCancel`: after the person cancels (the box is already closed), e.g. to put the node's values back in the form. */
export function FreshProofBox({ proof, testId = 'fresh-proof', onCancel }: { proof: FreshProof; testId?: string; onCancel?: () => void }) {
    const { refusal, lastCode, busy, code, setCode, opened } = proof;
    const cancel = () => {
        proof.close();
        onCancel?.();
    };
    const boxRef = useRef<HTMLElement | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        const box = boxRef.current;
        if (!refusal || !box) return;
        showOpened(box, refusal.kind === 'code' && inputRef.current ? inputRef.current : box);
        // Only on opening: a wrong code's answer keeps the person where they are.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [opened]);

    if (!refusal) return null;

    if (refusal.kind !== 'code') {
        const sentence = refusal.kind === 'phone' ? t(W.phone) : refusal.kind === 'step-up' ? t(W.stepUp) : t(W.needs2fa);
        return (
            <div ref={(el) => { boxRef.current = el; }} tabIndex={-1}
                className="mt-3 p-3 rounded-xl border border-amber-500/40 bg-bp-chip-warn-tint text-sm text-bp-chip-warn-ink break-words scroll-mt-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                role="alert" data-testid={`${testId}-${refusal.kind}`}>
                <p className="m-0">{sentence}</p>
                <button type="button" onClick={cancel} data-testid={`${testId}-dismiss`}
                    className="mt-1 min-h-[44px] inline-flex items-center text-xs text-nature-300 hover:text-nature-100 underline bg-transparent border-0 p-0 cursor-pointer">
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
        <form ref={(el) => { boxRef.current = el; }} onSubmit={send} data-testid={`${testId}-code`}
            className="mt-3 p-3 rounded-xl border border-nature-700 bg-nature-950/60 space-y-2 text-sm min-w-0 scroll-mt-4">
            <p className="m-0 text-nature-200 break-words">{lastCode ? t(W.codeAgain) : (refusal.error || t(W.codeAsk))}</p>
            {lastCode && refusal.error && (
                <p className="m-0 text-xs text-red-300 break-words" role="alert" data-testid={`${testId}-error`}>{refusal.error}</p>
            )}
            <label className="block text-xs text-nature-400" htmlFor={`${testId}-input`}>{t(W.codeLabel)}</label>
            <div className="flex flex-wrap gap-2">
                <input id={`${testId}-input`} data-testid={`${testId}-input`} value={code} ref={inputRef}
                    onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" inputMode="text" maxLength={32}
                    className="flex-1 min-w-[8rem] px-3 py-2 rounded-lg bg-nature-900 border border-nature-700 text-nature-100 font-mono tracking-widest" />
                <button type="submit" disabled={!canSend} data-testid={`${testId}-confirm`}
                    className="min-h-[44px] px-4 py-2 rounded-lg bg-bp-cta-fill hover:bg-bp-cta-hover text-bp-cta-on text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed">
                    {busy ? t(W.checking) : t(W.confirm)}
                </button>
                <button type="button" onClick={cancel} data-testid={`${testId}-cancel`}
                    className="min-h-[44px] px-3 py-2 rounded-lg border border-nature-700 text-nature-300 text-sm bg-transparent">
                    {t(W.cancel)}
                </button>
            </div>
        </form>
    );
}
