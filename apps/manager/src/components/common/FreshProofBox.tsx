import { useCallback, useEffect, useRef, useState } from 'react';
import { FRESH_PROOF_WORDS as W, freshProofRefusalOf, refusalOf, t, type FreshProofRefusal } from '../../lib/fresh-proof';

/**
 * An owner's fresh proof on a manager screen (lib/fresh-proof.ts; server admin-auth.ts requireFreshProof). A screen's
 * send function reports the server's answer to `check` (a Response) or `checkError` (a thrown FreshProofRequiredError).
 * When the server asks the proof, the box opens:
 *   the phone viewer      (a stale Manage hand-off) "Press Manage on your phone again…";
 *   the computer viewer   (a key session from "Sign in with your phone") "Do this from your phone…".
 * The server never asks for a typed code, so the box has no field: it says what to do on the phone, and Cancel closes it.
 * On opening it scrolls itself into view and takes focus, wherever the screen put it (opus-2028 B1): the button pressed
 * may be a screen away.
 *
 * `retry` and `sentCode` are what the screens still pass from the typed-code days; nothing reads them. They go with the
 * helpers' `code` argument in the next slice.
 */
export interface FreshProof {
    refusal: FreshProofRefusal | null;
    /** Counts the box's openings (none → a refusal, or one kind to another): the box scrolls and focuses on each. */
    opened: number;
    /** After a fetch: true when the server asked the proof (the box is open; stop), false otherwise (the box closes). */
    check: (res: Response, retry: (code: string) => Promise<unknown>, sentCode?: string) => Promise<boolean>;
    /** After a thrown error: true when it was the proof (the box is open), false otherwise. */
    checkError: (err: unknown, retry: (code: string) => Promise<unknown>, sentCode?: string) => boolean;
    close: () => void;
}

export function useFreshProof(): FreshProof {
    const [refusal, setRefusal] = useState<FreshProofRefusal | null>(null);
    const [opened, setOpened] = useState(0);

    const open = useCallback((r: FreshProofRefusal | null) => {
        if (r) {
            // Opening, a different ask, or a new request's ask (a second press of the screen's button while the box is
            // open too): the box comes into view again.
            setOpened((n) => n + 1);
            setRefusal(r);
            return true;
        }
        setRefusal(null);
        return false;
    }, []);

    const check = useCallback(async (res: Response, _retry: (code: string) => Promise<unknown>, _sentCode?: string) => {
        return open(await freshProofRefusalOf(res));
    }, [open]);

    const checkError = useCallback((err: unknown, _retry: (code: string) => Promise<unknown>, _sentCode?: string) => {
        return open(refusalOf(err));
    }, [open]);

    const close = useCallback(() => {
        setRefusal(null);
    }, []);

    return { refusal, opened, check, checkError, close };
}

/** Bring a just-opened box into view and give it focus. */
function showOpened(box: HTMLElement) {
    // In a modal or wizard the box goes to the top of the overlay, clear of the phone's keyboard; on a page, the least
    // scrolling that shows it whole.
    const inModal = Boolean(box.closest('[data-bp-modal]'));
    box.scrollIntoView?.({ block: inModal ? 'start' : 'nearest', inline: 'nearest' });
    box.focus({ preventScroll: true });
}

/** `onCancel`: after the person cancels (the box is already closed), e.g. to put the node's values back in the form. */
export function FreshProofBox({ proof, testId = 'fresh-proof', onCancel }: { proof: FreshProof; testId?: string; onCancel?: () => void }) {
    const { refusal, opened } = proof;
    const cancel = () => {
        proof.close();
        onCancel?.();
    };
    const boxRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        const box = boxRef.current;
        if (!refusal || !box) return;
        showOpened(box);
        // Only on opening.
    }, [opened]);

    if (!refusal) return null;

    const sentence = refusal.kind === 'phone' ? t(W.phone) : t(W.stepUp);
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
