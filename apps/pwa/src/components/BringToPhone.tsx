/**
 * Settings → Use the phone app → Put your account on your phone (front doors S9): this browser brings the account it holds
 * to the phone app, so nobody types 12 words on a phone. The phone's side is apps/native app/pair-in.tsx; the relay's,
 * apps/server pairing-relay.ts.
 *
 * What protects the account:
 *  - The code shows a fresh session key and this community's address, never the account. The session lasts 120 s,
 *    one phone may scan it, and only this browser (its httpOnly binding cookie) hears about it.
 *  - The PHONE shows four digits; the member types them HERE. Until they match, this browser does not even learn the
 *    phone's key, so a phone that scanned the code from over a shoulder, a screen share or a photo gets nothing: its
 *    digits are on its own screen, not the member's. Three wrong tries end the session with nothing sent.
 *  - Only then is the account sealed to that phone's key with this session's key (core sealPairingPayloadToPhone),
 *    and sent once. What is sent is the 12 words and the public key they make (the phone checks that), and the name
 *    to show. Never the private key: the phone makes it from the words.
 *  - The phone fetching the seal is not the phone saving it: it saves only at the member's tap on the phone. So this
 *    browser offers to remove the account here only once the phone has told the relay, with its own secret, that it
 *    SAVED it (the poll's 'saved'). Until then it says the phone has received it, and what to tap there. A refusal, a
 *    failed save, a cancel on the phone, or no word within SAVE_WAIT_MS: it says so, and the account stays here.
 *    Removing is never forced: two devices are allowed.
 *  - One Confirm at a time: a second click, or Enter and a click, sends nothing while the first is out. An answer this
 *    browser can't use (lost, or anything but released, wrong or burned) is a note to try again, never an end: the
 *    poll says what the relay did.
 */
import React, { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { createPairingSession, nodeOrigin, sealPairingPayloadToPhone, t, word } from '@beanpool/core';
import { cancelPairingApi, confirmPairingApi, getNodeApiUrl, initPairingToPhoneApi, pollPairingToPhoneApi, sendToPhoneApi } from '../lib/api';
import { getMnemonic, loadIdentity } from '../lib/identity';

// qrcode.react's types predate this React's JSX types (WelcomePage casts it the same way).
const QRCode: React.FC<{ value: string; size: number; level: string; marginSize: number; style?: React.CSSProperties }> = QRCodeSVG as any;

export const BRING_TO_PHONE_WORDS = {
    open: word('Put your account on your phone'),
    openSub: word('Scan a code with the BeanPool app. No typing your 12 words.'),
    steps: word('On your phone, open the BeanPool app, tap Already a Member? Restore Account, then Scan from a browser. Scan this code.'),
    samePhone: word('Using BeanPool in the browser on the same phone? Open the app from here instead.'),
    openApp: word('Open the BeanPool app'),
    qrLabel: word('QR code to bring your account to the BeanPool app'),
    digits: word('Type the four digits your phone shows'),
    why: word('Your account goes to your phone only after the right digits. Three wrong tries and nothing is sent.'),
    confirm: word('Confirm'),
    wrong: word('Those are not the digits on the phone. Check them and try again.'),
    retry: word('That did not go through. Try again.'),
    sending: word('Sending your account to your phone…'),
    received: word('Your phone has received your account. On your phone, tap Bring it to this phone.'),
    done: word('Your phone has saved your account.'),
    removeLine: word('Your account is now on this browser and your phone. You can keep both, or remove it from this browser.'),
    notSaved: word("Your phone didn't save your account, so it is still here on this browser. Make a new code to try again."),
    unheard: word("Your phone hasn't said it saved your account, so it is still here on this browser. If your phone shows your account, it is on both."),
    remove: word('Remove from this browser'),
    expired: word('This code has run out. Make a new one.'),
    burned: word('The digits were typed wrong three times, so nothing was sent. Make a new code.'),
    noWords: word("This browser doesn't hold your 12 recovery words, so it can't send your account this way. On your phone, restore with your social sign-in or your community instead."),
    failed: word("Couldn't reach your community. Check your connection and try again."),
    again: word('Make a new code'),
    cancel: word('Cancel'),
} as const;

type Phase = 'idle' | 'code' | 'digits' | 'sending' | 'received' | 'done' | 'notSaved' | 'unheard' | 'expired' | 'burned' | 'noWords' | 'failed';

const POLL_MS = 1_500;
const SESSION_MS = 120_000;
/** After the phone collects: how long this browser waits for it to say it saved the account (the relay's SAVE_WINDOW_MS). */
export const SAVE_WAIT_MS = 5 * 60_000;

export function BringToPhone({ isPhone = false, onRemoveHere }: { isPhone?: boolean; onRemoveHere?: () => void }) {
    const [phase, setPhase] = useState<Phase>('idle');
    const [qrValue, setQrValue] = useState('');
    const [digits, setDigits] = useState('');
    const [note, setNote] = useState<string | null>(null);
    const session = useRef<{ sessionId: string; privateKeyHex: string; endsAt: number; collected: boolean } | null>(null);
    const sending = useRef(false);
    /** A Confirm is out: no second one until its answer is back. */
    const confirming = useRef(false);
    const [confirmBusy, setConfirmBusy] = useState(false);

    const end = useCallback((next: Phase) => {
        const s = session.current;
        session.current = null;
        if (s && next !== 'done') void cancelPairingApi(s.sessionId);
        setPhase(next);
    }, []);

    useEffect(() => () => {
        const s = session.current;
        session.current = null;
        if (s) void cancelPairingApi(s.sessionId);
    }, []);

    const start = async () => {
        setNote(null);
        setDigits('');
        const identity = await loadIdentity().catch(() => null);
        const words = await getMnemonic(identity);
        if (!identity || !words || words.length !== 12) {
            setPhase('noWords');
            return;
        }
        const s = createPairingSession();
        try {
            await initPairingToPhoneApi(s.sessionId, s.publicKeyHex);
        } catch {
            setPhase('failed');
            return;
        }
        const origin = nodeOrigin(getNodeApiUrl() || window.location.origin) ?? '';
        session.current = { sessionId: s.sessionId, privateKeyHex: s.privateKeyHex, endsAt: Date.now() + SESSION_MS, collected: false };
        sending.current = false;
        confirming.current = false;
        setConfirmBusy(false);
        setQrValue(`beanpool://pair-in?session=${s.sessionId}&pub=${s.publicKeyHex}&node=${encodeURIComponent(origin)}`);
        setPhase('code');
    };

    // While a code is up, and until the phone says whether it saved the account: ask the relay every 1.5 s.
    const live = phase === 'code' || phase === 'digits' || phase === 'sending' || phase === 'received';
    useEffect(() => {
        if (!live) return;
        let stop = false;
        let timer: ReturnType<typeof setTimeout>;
        const tick = async () => {
            const s = session.current;
            if (stop || !s) return;
            // Once collected, a session that runs out without the phone's word is not a success: the account stays here.
            if (Date.now() >= s.endsAt) { end(s.collected ? 'unheard' : 'expired'); return; }
            const res = await pollPairingToPhoneApi(s.sessionId).catch(() => null);
            if (stop || session.current !== s) return;
            const status = res?.status;
            if (status === 'confirming') setPhase((p) => (p === 'code' ? 'digits' : p));
            else if (status === 'released' && res?.phonePubHex && !sending.current) {
                sending.current = true;
                setPhase('sending');
                const ok = await seal(s, res.phonePubHex);
                if (!ok && !stop) { end('failed'); return; }
            } else if (status === 'collected') {
                // The phone has the seal, not yet the account: it saves at the member's tap there. Wait for its word.
                if (!s.collected) {
                    s.collected = true;
                    s.endsAt = Date.now() + SAVE_WAIT_MS;
                    setPhase('received');
                }
            } else if (status === 'saved') { end('done'); return; }
            else if (status === 'not-saved') { end('notSaved'); return; }
            else if (status === 'burned') { end('burned'); return; }
            else if (status === 'expired' || status === 'wrong-browser') { end(s.collected ? 'unheard' : 'expired'); return; }
            timer = setTimeout(tick, POLL_MS);
        };
        timer = setTimeout(tick, POLL_MS);
        return () => { stop = true; clearTimeout(timer); };
    }, [live, end]);

    /** Sealed to the phone's key with this session's key, then sent once. The words come from the store again here. */
    async function seal(s: { sessionId: string; privateKeyHex: string }, phonePubHex: string): Promise<boolean> {
        const identity = await loadIdentity().catch(() => null);
        const words = await getMnemonic(identity);
        if (!identity || !words) return false;
        const sealed = sealPairingPayloadToPhone(
            { version: 1, publicKey: identity.publicKey, mnemonic: words, callsign: identity.callsign || '' },
            s.privateKeyHex, phonePubHex, s.sessionId,
        );
        const res = await sendToPhoneApi(s.sessionId, sealed.nonceHex, sealed.ciphertextHex).catch(() => ({ ok: false, status: 0 }));
        return res.ok;
    }

    const confirm = async (e: FormEvent) => {
        e.preventDefault();
        const s = session.current;
        if (!s || digits.length !== 4 || confirming.current) return;
        confirming.current = true;
        setConfirmBusy(true);
        const res = await confirmPairingApi(s.sessionId, digits).catch(() => null);
        confirming.current = false;
        setConfirmBusy(false);
        if (session.current !== s) return;
        if (res?.result === 'released') { setNote(null); setPhase((p) => (p === 'digits' ? 'sending' : p)); return; }
        if (res?.result === 'wrong') { setNote(t(BRING_TO_PHONE_WORDS.wrong)); setDigits(''); return; }
        if (res?.result === 'burned') { end('burned'); return; }
        // A lost answer, or one this browser can't use: the session stays, and the poll says what the relay did.
        setNote(t(BRING_TO_PHONE_WORDS.retry));
    };

    const box = 'mt-3 p-3 rounded-xl bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-700';
    const primary = 'min-h-[44px] px-5 py-2 rounded-lg bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on font-bold border-none cursor-pointer disabled:opacity-60';
    const quiet = 'min-h-[44px] px-4 py-2 rounded-lg bg-nature-100 dark:bg-nature-800 text-nature-800 dark:text-nature-100 font-bold border-none cursor-pointer';
    const line = 'm-0 mt-2 text-sm leading-relaxed text-nature-700 dark:text-nature-200';

    if (phase === 'idle') {
        return (
            <button type="button" onClick={() => void start()} className={`${box} w-full text-left cursor-pointer`} data-testid="bring-to-phone-open">
                <span className="block font-bold text-nature-900 dark:text-white">{t(BRING_TO_PHONE_WORDS.open)}</span>
                <span className="block mt-0.5 text-xs text-nature-600 dark:text-nature-300">{t(BRING_TO_PHONE_WORDS.openSub)}</span>
            </button>
        );
    }

    return (
        <div className={box} data-testid="bring-to-phone">
            {phase === 'code' && (
                <>
                    <p className={line}>{t(BRING_TO_PHONE_WORDS.steps)}</p>
                    {/* The code on white in both themes: a camera reads dark on light. It shrinks with its box, never past it:
                        at 320 px with text at 130% the box is narrower than 200 px, and a code cut at its edge may not scan. */}
                    <div role="img" aria-label={t(BRING_TO_PHONE_WORDS.qrLabel)} className="mt-3 mx-auto w-full max-w-[216px] box-border p-2 rounded-lg bg-white">
                        <QRCode value={qrValue} size={200} level="M" marginSize={2} style={{ display: 'block', width: '100%', height: 'auto' }} />
                    </div>
                    {isPhone && (
                        <>
                            <p className={line}>{t(BRING_TO_PHONE_WORDS.samePhone)}</p>
                            <a href={qrValue} className="inline-block mt-2 font-bold text-emerald-700 dark:text-emerald-400">{t(BRING_TO_PHONE_WORDS.openApp)}</a>
                        </>
                    )}
                </>
            )}
            {phase === 'digits' && (
                <form onSubmit={(e) => void confirm(e)} className="text-center">
                    <label htmlFor="bring-to-phone-digits" className="block font-bold text-nature-900 dark:text-white">{t(BRING_TO_PHONE_WORDS.digits)}</label>
                    <input
                        id="bring-to-phone-digits"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        pattern="[0-9]{4}"
                        maxLength={4}
                        required
                        autoFocus
                        value={digits}
                        onChange={(e) => setDigits(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
                        className="mt-3 w-full max-w-[9.5rem] box-border text-3xl tracking-[0.3em] text-center p-1.5 rounded-lg border-2 border-nature-500 text-nature-900 dark:text-white bg-white dark:bg-nature-950"
                    />
                    <div className="mt-3">
                        <button type="submit" disabled={digits.length !== 4 || confirmBusy} className={primary}>{t(BRING_TO_PHONE_WORDS.confirm)}</button>
                    </div>
                    {note && <p role="alert" className="m-0 mt-2 text-sm text-red-700 dark:text-red-300">{note}</p>}
                    <p className={line}>{t(BRING_TO_PHONE_WORDS.why)}</p>
                </form>
            )}
            {phase === 'sending' && <p className={line} role="status">{t(BRING_TO_PHONE_WORDS.sending)}</p>}
            {phase === 'received' && <p className={`${line} font-bold`} role="status">{t(BRING_TO_PHONE_WORDS.received)}</p>}
            {phase === 'done' && (
                <>
                    <p className={`${line} font-bold`} role="status">{t(BRING_TO_PHONE_WORDS.done)}</p>
                    {onRemoveHere && (
                        <>
                            <p className={line}>{t(BRING_TO_PHONE_WORDS.removeLine)}</p>
                            <div className="mt-3"><button type="button" onClick={onRemoveHere} className={quiet}>{t(BRING_TO_PHONE_WORDS.remove)}</button></div>
                        </>
                    )}
                </>
            )}
            {phase === 'notSaved' && <p role="alert" className={line}>{t(BRING_TO_PHONE_WORDS.notSaved)}</p>}
            {phase === 'unheard' && <p role="alert" className={line}>{t(BRING_TO_PHONE_WORDS.unheard)}</p>}
            {phase === 'expired' && <p role="alert" className={line}>{t(BRING_TO_PHONE_WORDS.expired)}</p>}
            {phase === 'burned' && <p role="alert" className={line}>{t(BRING_TO_PHONE_WORDS.burned)}</p>}
            {phase === 'noWords' && <p role="alert" className={line}>{t(BRING_TO_PHONE_WORDS.noWords)}</p>}
            {phase === 'failed' && <p role="alert" className={line}>{t(BRING_TO_PHONE_WORDS.failed)}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
                {(phase === 'expired' || phase === 'burned' || phase === 'failed' || phase === 'notSaved') && (
                    <button type="button" onClick={() => void start()} className={primary}>{t(BRING_TO_PHONE_WORDS.again)}</button>
                )}
                {/* Not while the phone may still save it (nothing here can stop that), nor once it has. */}
                {phase !== 'done' && phase !== 'received' && (
                    <button type="button" onClick={() => end('idle')} className={quiet}>{t(BRING_TO_PHONE_WORDS.cancel)}</button>
                )}
            </div>
        </div>
    );
}
