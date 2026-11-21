/**
 * The web's named line at the member's own act, and the browser's answer for the true lines
 * (scratch/fable-design/DESIGN-notify-and-backup-asks-fable-amend2.md §6, §12.3 slice N5b; the first design §4.2, §4.8,
 * amend1 §4.3). The phone's twins are apps/native/components/NotifyLine.tsx and useNotifyPhone.ts: the same moments, the
 * same words (core notifyLineWords, notifyEventLineWords) and the same rule (core notifyAsks, read for this browser through
 * lib/web-push.ts offerNamedLineHere), so the two apps cannot drift.
 *
 * "Hear when Asha answers." [Tell me]: one line with one button and no "Not now"; leaving the place is the no. Shown only
 * where core's rule allows (each kind once for this account in this browser, one soft ask a day with one line still
 * allowed on the join's day, never after the browser's no, never where web push can't reach this browser or this account's
 * notifications are already on here). Only a tap on Tell me brings the browser's own prompt (lib/web-push.ts turnOnFromAsk:
 * nothing is awaited before it inside the tap). Allowed: the line says "You'll hear when Asha answers.". Refused, or closed
 * with no answer: the line goes without a word. Words and button wrap at 320 px and 130% text; colours from the tokens.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { notifyLineWords, type NotifyLineKind, type NotifyPhone } from '@beanpool/core';
import { loadIdentity, type BeanPoolIdentity } from '../lib/identity';
import { useLanguage } from '../lib/useLanguage';
import { notifyPhoneHere, offerNamedLineHere, turnOnFromAsk } from '../lib/web-push';

export interface NotifyLineOffer {
    kind: NotifyLineKind;
    /** The person (answer, again, offer) the member waits on. */
    name?: string | null;
    /** Where on the page it hangs: a chat line's id. */
    anchor?: string | null;
    /** Under the member's own line ('end'), or anyone else's ('start', the default). */
    align?: 'start' | 'end';
}

type Shown = NotifyLineOffer & { state: 'offer' | 'busy' | 'done' };

/** A named line's words: the offer, what it says once notifications are on, and its button. */
export type NotifyLineText = { line: string; done: string; button: string };

/** Every place drawing from the browser's answer (useNotifyBrowser), told to read it again after a Tell me or a Turn on. */
const browserReaders = new Set<() => void>();

/** A Tell me or a Turn on has had its answer: every true line on the page reads the browser again. */
export function noteBrowserChanged(): void {
    for (const read of [...browserReaders]) read();
}

const NOTHING_HERE: NotifyPhone = { available: false, granted: false, canAskAgain: false };

/**
 * The browser's answer for this account, as core's rule reads a phone (lib/web-push.ts notifyPhoneHere): null until read,
 * then read again whenever the page comes back into view (back from the browser's site settings) and after any Tell me or
 * Turn on here (noteBrowserChanged). Never asks. `wanted`: only while a true line could be drawn; null while not wanted.
 */
export function useNotifyBrowser(publicKey: string | null | undefined, wanted = true): NotifyPhone | null {
    const [phone, setPhone] = useState<NotifyPhone | null>(null);
    useEffect(() => {
        if (!wanted || !publicKey) return;
        let live = true;
        const read = () => {
            let p = NOTHING_HERE;
            try { p = notifyPhoneHere(publicKey); } catch { /* nothing to turn on here */ }
            if (live) setPhone(p);
        };
        read();
        browserReaders.add(read);
        const onVisible = () => { if (document.visibilityState === 'visible') read(); };
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('focus', read);
        return () => {
            live = false;
            browserReaders.delete(read);
            document.removeEventListener('visibilitychange', onVisible);
            window.removeEventListener('focus', read);
        };
    }, [publicKey, wanted]);
    return wanted && publicKey ? phone : null;
}

/**
 * One place's named line: `offer` asks core's rule and, where it allows, shows the line (one per place); `view` is the line
 * to draw, or null; `draw(words)` draws it in words the place says are true now (an event's line follows the answer as it
 * is: core notifyEventLineWords), and nothing where those are null.
 *
 * `showing` is whether the place is on screen now (a sheet's or a card's own flag; a page that leaves unmounts, which ends
 * it too). When it goes false the line goes for good: leaving is the no for that kind. Nothing is offered while hidden.
 * `identity`, where the place has it; else the browser's own account is read at the offer, so Tell me has it in hand and
 * its prompt is the first thing the tap awaits.
 */
export function useNotifyLine(publicKey: string | null | undefined, showing = true, identity?: BeanPoolIdentity | null) {
    const [shown, setShown] = useState<Shown | null>(null);
    const [lang] = useLanguage();
    const taken = useRef(false);
    const mounted = useRef(true);
    const showingNow = useRef(showing);
    const visit = useRef(0);
    const who = useRef<BeanPoolIdentity | null>(identity ?? null);
    if (identity) who.current = identity;
    useEffect(() => () => { mounted.current = false; }, []);
    useEffect(() => {
        showingNow.current = showing;
        if (!showing) {
            visit.current++;
            setShown(null);
        }
    }, [showing]);

    const offer = useCallback(async (next: NotifyLineOffer): Promise<boolean> => {
        if (taken.current || !showingNow.current || !publicKey) return false;
        taken.current = true;
        const askedIn = visit.current;
        if (!who.current) who.current = await loadIdentity().catch(() => null);
        // The account that can turn notifications on is this one, or no line: Tell me would have nothing to sign with. A
        // failure reading the browser or the record only means no line, as on the phone.
        let ok = false;
        try {
            ok = who.current?.publicKey === publicKey && mounted.current && showingNow.current && visit.current === askedIn
                && offerNamedLineHere(publicKey, next.kind);
        } catch {
            ok = false;
        }
        if (!ok) taken.current = false;
        else setShown({ ...next, state: 'offer' });
        return ok;
    }, [publicKey]);

    const tellMe = useCallback(() => {
        const id = who.current;
        if (!id) return;
        setShown((s) => (s ? { ...s, state: 'busy' } : s));
        // The browser's prompt is the first thing this tap waits on (turnOnFromAsk): its answer kept as the phone's is.
        void turnOnFromAsk(id, lang, 'line').then((r) => {
            if (mounted.current) setShown((s) => (s && r === 'ok' ? { ...s, state: 'done' } : null));
            noteBrowserChanged();
        });
    }, [lang]);

    const line = showing ? shown : null;
    const draw = (words?: NotifyLineText | null) => (line && words !== null
        ? <NotifyLine kind={line.kind} name={line.name} state={line.state} onTellMe={tellMe} align={line.align} words={words} />
        : null);
    return { line, offer, view: draw(), draw };
}

export function NotifyLine({ kind, name, state, onTellMe, align = 'start', words: given }: {
    kind: NotifyLineKind;
    name?: string | null;
    state: Shown['state'];
    onTellMe: () => void;
    align?: 'start' | 'end';
    words?: NotifyLineText;
}) {
    const words = given ?? notifyLineWords(kind, name);
    const side = align === 'end' ? 'self-end justify-end text-right' : 'self-start';
    if (state === 'done') {
        return (
            <p role="status" data-testid="notify-line-done" dir="auto" className={`m-0 my-0.5 px-1 max-w-full text-[0.8125rem] text-text-secondary break-words ${side}`}>
                <span aria-hidden="true" className="text-bp-ink-success">✓ </span>{words.done}
            </p>
        );
    }
    const busy = state === 'busy';
    return (
        <div data-testid="notify-line" className={`flex flex-wrap items-center gap-x-1 my-0.5 px-1 max-w-full min-w-0 ${side}`}>
            <span dir="auto" className="min-w-0 text-[0.8125rem] text-text-secondary break-words">{words.line}</span>
            <button type="button" data-testid="notify-line-tell-me" onClick={onTellMe} disabled={busy} aria-busy={busy}
                className="min-h-[44px] min-w-[44px] px-2.5 rounded-lg bg-transparent border-none text-sm font-bold text-bp-ink-info break-words cursor-pointer disabled:opacity-60 disabled:cursor-wait focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-brand">
                {words.button}
            </button>
        </div>
    );
}
