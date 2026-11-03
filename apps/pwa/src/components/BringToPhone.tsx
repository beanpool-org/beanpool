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
 *  - Afterwards this browser offers to remove the account here (never forced: two devices are allowed).
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { createPairingSession, nodeOrigin, sealPairingPayloadToPhone, t, word } from '@beanpool/core';
import { cancelPairingApi, confirmPairingApi, getNodeApiUrl, initPairingToPhoneApi, pollPairingToPhoneApi, sendToPhoneApi } from '../lib/api';
import { getMnemonic, loadIdentity } from '../lib/identity';

export const BRING_TO_PHONE_WORDS = {
    open: word('Put your account on your phone'),
    openSub: word('Scan a code with the BeanPool app. No typing your 12 words.'),
    steps: word('On your phone, open the BeanPool app, tap Already a member? Restore, then Scan from a browser. Scan this code.'),
    samePhone: word('Using BeanPool in the browser on the same phone? Open the app from here instead.'),
    openApp: word('Open the BeanPool app'),
    qrLabel: word('QR code to bring your account to the BeanPool app'),
    digits: word('Type the four digits your phone shows'),
    why: word('Your account goes to your phone only after the right digits. Three wrong tries and nothing is sent.'),
    confirm: word('Confirm'),
    wrong: word('Those are not the digits on the phone. Check them and try again.'),
    sending: word('Sending your account to your phone…'),
    done: word('Your phone has your account. Finish on your phone.'),
    removeLine: word('Your account is now on this browser and your phone. You can keep both, or remove it from this browser.'),
    remove: word('Remove from this browser'),
    expired: word('This code has run out. Make a new one.'),
    burned: word('The digits were typed wrong three times, so nothing was sent. Make a new code.'),
    noWords: word("This browser doesn't hold your 12 recovery words, so it can't send your account this way. On your phone, restore with your social sign-in or your community instead."),
    failed: word("Couldn't reach your community. Check your connection and try again."),
    again: word('Make a new code'),
    cancel: word('Cancel'),
} as const;

type Phase = 'idle' | 'code' | 'digits' | 'sending' | 'done' | 'expired' | 'burned' | 'noWords' | 'failed';

const POLL_MS = 1_500;
const SESSION_MS = 120_000;

export function BringToPhone({ isPhone = false, onRemoveHere }: { isPhone?: boolean; onRemoveHere?: () => void }) {
    const [phase, setPhase] = useState<Phase>('idle');
    const [qrValue, setQrValue] = useState('');
    const [digits, setDigits] = useState('');
    const [note, setNote] = useState<string | null>(null);
    const session = useRef<{ sessionId: string; privateKeyHex: string; endsAt: number } | null>(null);
    const sending = useRef(false);

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
        session.current = { sessionId: s.sessionId, privateKeyHex: s.privateKeyHex, endsAt: Date.now() + SESSION_MS };
        sending.current = false;
        setQrValue(`beanpool://pair-in?session=${s.sessionId}&pub=${s.publicKeyHex}&node=${encodeURIComponent(origin)}`);
        setPhase('code');
    };

    // While a code is up: ask the relay every 1.5 s what the phone has done.
    const live = phase === 'code' || phase === 'digits' || phase === 'sending';
    useEffect(() => {
        if (!live) return;
        let stop = false;
        let timer: ReturnType<typeof setTimeout>;
        const tick = async () => {
            const s = session.current;
            if (stop || !s) return;
            if (Date.now() >= s.endsAt) { end('expired'); return; }
            const res = await pollPairingToPhoneApi(s.sessionId).catch(() => null);
            if (stop || session.current !== s) return;
            const status = res?.status;
            if (status === 'confirming') setPhase((p) => (p === 'code' ? 'digits' : p));
            else if (status === 'released' && res?.phonePubHex && !sending.current) {
                sending.current = true;
                setPhase('sending');
                const ok = await seal(s, res.phonePubHex);
                if (!ok && !stop) { end('failed'); return; }
            } else if (status === 'collected') { end('done'); return; }
            else if (status === 'burned') { end('burned'); return; }
            else if (status === 'expired' || status === 'wrong-browser') { end('expired'); return; }
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
        if (!s || digits.length !== 4) return;
        const res = await confirmPairingApi(s.sessionId, digits).catch(() => ({ result: 'expired' as const }));
        if (res.result === 'released') { setNote(null); setPhase('sending'); return; }
        if (res.result === 'wrong') { setNote(t(BRING_TO_PHONE_WORDS.wrong)); setDigits(''); return; }
        end(res.result === 'burned' ? 'burned' : 'expired');
    };

    const box = 'mt-3 p-4 rounded-xl bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-700';
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
                    {/* The code on white in both themes: a camera reads dark on light. */}
                    <div role="img" aria-label={t(BRING_TO_PHONE_WORDS.qrLabel)} className="mt-3 mx-auto w-fit max-w-full p-3 rounded-lg bg-white">
                        <QRCodeSVG value={qrValue} size={200} level="M" marginSize={2} />
                    </div>
                    {isPhone && (
                        <p className={line}>
                            {t(BRING_TO_PHONE_WORDS.samePhone)}{' '}
                            <a href={qrValue} className="font-bold text-emerald-700 dark:text-emerald-400">{t(BRING_TO_PHONE_WORDS.openApp)}</a>
                        </p>
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
                        className="mt-3 w-full max-w-[9.5rem] box-border text-3xl tracking-[0.3em] text-center p-1.5 rounded-lg border-2 border-nature-500 text-nature-900 bg-white"
                    />
                    <div className="mt-3">
                        <button type="submit" disabled={digits.length !== 4} className={primary}>{t(BRING_TO_PHONE_WORDS.confirm)}</button>
                    </div>
                    {note && <p role="alert" className="m-0 mt-2 text-sm text-red-700 dark:text-red-300">{note}</p>}
                    <p className={line}>{t(BRING_TO_PHONE_WORDS.why)}</p>
                </form>
            )}
            {phase === 'sending' && <p className={line} role="status">{t(BRING_TO_PHONE_WORDS.sending)}</p>}
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
            {phase === 'expired' && <p role="alert" className={line}>{t(BRING_TO_PHONE_WORDS.expired)}</p>}
            {phase === 'burned' && <p role="alert" className={line}>{t(BRING_TO_PHONE_WORDS.burned)}</p>}
            {phase === 'noWords' && <p role="alert" className={line}>{t(BRING_TO_PHONE_WORDS.noWords)}</p>}
            {phase === 'failed' && <p role="alert" className={line}>{t(BRING_TO_PHONE_WORDS.failed)}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
                {(phase === 'expired' || phase === 'burned' || phase === 'failed') && (
                    <button type="button" onClick={() => void start()} className={primary}>{t(BRING_TO_PHONE_WORDS.again)}</button>
                )}
                {phase !== 'done' && (
                    <button type="button" onClick={() => end('idle')} className={quiet}>{t(BRING_TO_PHONE_WORDS.cancel)}</button>
                )}
            </div>
        </div>
    );
}
