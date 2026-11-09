/**
 * Waiting to be let in (DESIGN-shared-listing-door-fable.md §2.1, slice A1): a browser that asked this community to let it
 * in, with the key it made at Send (lib/knock-key.ts), and no answer yet. Not the member app: nothing here is read as a
 * member, and the root (App.tsx) never sets this key as one. What it reads is the request's own status, signed by the key,
 * from this community's knock route (lib/knock.ts readKnockStatus), as the page opens and every 5 minutes while it is open.
 *
 *   - waiting: "You asked to join {name} on {date}. Your request arrived.", Check again, Cancel my request (the 24 h rule);
 *   - a yes: "🎉 {name} said yes." and **Join {name}**, which hands the invite to the welcome page, where it is redeemed
 *     with this same key (the invite is bound to it), then the wizard with the 12 words for the first time;
 *   - nothing open (lapsed, cancelled, refused): today's words, Ask again, and Forget this request, which wipes a key no
 *     community accepted;
 *   - always: I have an invite, Already a member, and 🌍 Look around the global community (with `?ask=<host>`, so a join
 *     there finds this community again), where the community names one;
 *   - while waiting, on the community's own address: "Tell me when they answer" (web push W1, lib/web-push.ts), which asks
 *     the browser only when tapped, and says plainly where it can't work. A click on its notification lands here with the
 *     notice in the fragment: one this community signed for this key just reads the status again; a forgery opens nothing
 *     and shows the phone's warning once.
 */
import { useCallback, useEffect, useState } from 'react';
import { COMMUNITY_CARD_WORDS as CW, FIND_COMMUNITY_WORDS as FW, communityCardName, formatDate, t, type CommunityCard } from '@beanpool/core';
import type { BeanPoolIdentity } from '../lib/identity';
import { getCommunityCard } from '../lib/api';
import { KNOCK_MESSAGES, cancelKnock, cancelledKnocks, readKnockStatus, rememberedKnocks, type KnockStatusResult, type RememberedKnock } from '../lib/knock';
import { forgetKnockKey } from '../lib/knock-key';
import { lookAroundUrl } from '../lib/community-card';
import { AskHere, thisCommunityOrigin } from '../components/AskHere';
import { LanguageSwitch } from '../components/LanguageSwitch';
import {
    TELL_ME_WORDS as TW, cannotLines, forgetWebPushPin, grantedLine, noticeInLocation, pushPlace, readWebPushPin, stopTellingMe,
    tellMeWhenTheyAnswer, type PushPlace,
} from '../lib/web-push';
import { PEEK_WORDS, currentLanguage } from '@beanpool/core';

/** How often the page reads the request's status while it is open. */
export const KNOCK_STATUS_EVERY_MS = 5 * 60_000;

const DOOR = 'block w-full min-h-[48px] px-4 py-3 rounded-xl text-center text-base font-bold break-words no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-info';
const PRIMARY = `${DOOR} border-none bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on cursor-pointer disabled:cursor-default disabled:opacity-60`;
const SECONDARY = `${DOOR} bg-transparent border border-bp-ink-info text-bp-ink-info cursor-pointer disabled:cursor-default disabled:opacity-60`;

export function KnockWaitingPage({ identity, onJoin, onInvite, onSignIn, onForgotten }: {
    identity: BeanPoolIdentity;
    /** A member said yes: join with this invite, with this key. */
    onJoin: (yes: { invite: string; name: string }) => void;
    /** I have an invite: the invite form, which joins with this same key. */
    onInvite: () => void;
    /** Already a member, once this request is forgotten here: the ways back. */
    onSignIn: () => void;
    /** The key this browser asked with is gone: the page a stranger sees. */
    onForgotten: () => void;
}) {
    const origin = thisCommunityOrigin();
    const [card, setCard] = useState<CommunityCard | null>(null);
    const [knock, setKnock] = useState<RememberedKnock | null>(null);
    const [status, setStatus] = useState<KnockStatusResult | null>(null);
    const [checking, setChecking] = useState(true);
    const [cancelled, setCancelled] = useState(false);
    const [confirm, setConfirm] = useState<'cancel' | 'signin' | null>(null);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const [askAgain, setAskAgain] = useState(false);

    // A click on the notification brought a notice (public/sw.js): the community's own just reads again; a forgery opens
    // nothing and is named once. The fragment goes at once, so a reload names nothing.
    useEffect(() => {
        if (!origin || !window.location.hash.includes('notice=')) return;
        const seen = noticeInLocation(window.location.hash, identity.publicKey, readWebPushPin(origin, identity.publicKey)?.pushKey ?? null);
        try { window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`); } catch { /* it stays */ }
        if (seen === 'forged') setNote(t(TW.forged));
    }, [origin, identity.publicKey]);

    useEffect(() => {
        let alive = true;
        getCommunityCard().then(c => { if (alive && c) setCard(c); }).catch(() => {});
        rememberedKnocks(identity.publicKey).then(ks => { if (alive) setKnock(ks.find(k => k.url === origin) ?? null); });
        cancelledKnocks(identity.publicKey).then(recent => { if (alive) setCancelled(!!origin && origin in recent); });
        return () => { alive = false; };
    }, [identity.publicKey, origin]);

    const check = useCallback(async () => {
        setChecking(true);
        const s = await readKnockStatus(origin, identity);
        // Nothing open here (lapsed, cancelled, or a no whose 24 hours are up): the community let go of this browser with
        // the request, so this browser lets go of its pin too, and an Ask again with this key shows Tell me afresh. A no
        // still blocked reads as waiting, so this tells nothing about one.
        if (origin && s.ok && s.value.status === 'none') forgetWebPushPin(origin, identity.publicKey);
        setStatus(s);
        setChecking(false);
    }, [origin, identity]);

    // On open, and every 5 minutes while open.
    useEffect(() => {
        void check();
        const timer = setInterval(() => { void check(); }, KNOCK_STATUS_EVERY_MS);
        return () => clearInterval(timer);
    }, [check]);

    const name = card ? communityCardName(card, { t }) : knock?.name ?? (origin ? origin.replace(/^https:\/\//, '') : t('this community'));
    const pending = !!status?.ok && status.value.status === 'pending';
    const approved = status?.ok && status.value.status === 'approved' ? status.value : null;
    const closed = !!status?.ok && status.value.status === 'none';
    const global = card ? lookAroundUrl(card) : null;

    const forget = async () => {
        setBusy(true);
        // The browser this request asked to be told on: let go while the key can still sign for it.
        if (origin) await stopTellingMe(origin, identity).catch(() => {});
        const gone = await forgetKnockKey(identity.publicKey).catch(() => false);
        setBusy(false);
        if (gone) return true;
        setNote(t("This browser couldn't forget the request. Reload the page and try again."));
        return false;
    };

    const doCancel = async () => {
        setBusy(true);
        const r = await cancelKnock(origin, identity);
        setBusy(false);
        setConfirm(null);
        if (r.ok) {
            // The community deleted this browser's subscription with the request (cancelKnock): the pin goes with it.
            if (origin) forgetWebPushPin(origin, identity.publicKey);
            setCancelled(true);
            setStatus({ ok: true, value: { status: 'none' } });
            return;
        }
        setNote(r.message);
    };

    if (askAgain) {
        return (
            <main data-testid="knock-waiting-ask-again" className="page-surface min-h-screen p-4 max-w-lg mx-auto text-text-primary">
                <AskHere name={name} held={identity} onAsked={() => {
                    setAskAgain(false);
                    setCancelled(false);
                    void rememberedKnocks(identity.publicKey).then(ks => setKnock(ks.find(x => x.url === origin) ?? null));
                    void check();
                }} onClose={() => setAskAgain(false)} />
            </main>
        );
    }

    let line: string;
    if (cancelled) line = t(KNOCK_MESSAGES.cancelled);
    else if (checking && !status) line = t('Checking…');
    else if (!status) line = t(FW.requestArrived);
    else if (!status.ok) line = status.message;
    else if (pending) line = t(FW.requestArrived);
    else if (closed) line = t(KNOCK_MESSAGES.none);
    else line = '';

    return (
        <main data-testid="knock-waiting" className="page-surface min-h-screen p-4 text-text-primary">
            <div className="max-w-lg mx-auto">
                <div className="flex justify-end mb-2"><LanguageSwitch /></div>
                <section className="p-5 max-[359px]:px-4 rounded-2xl bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 shadow-sm">
                    {approved ? (
                        <>
                            <h1 dir="auto" data-testid="knock-waiting-yes" className="m-0 mb-4 text-2xl font-bold leading-tight break-words">{t('🎉 {name} said yes.', { name })}</h1>
                            <button type="button" data-testid="knock-waiting-join" className={`${PRIMARY} mb-3`} onClick={() => onJoin({ invite: approved.invite, name })}>
                                {t('Join {name}', { name })}
                            </button>
                        </>
                    ) : (
                        <>
                            <h1 dir="auto" data-testid="knock-waiting-sent" className="m-0 mb-2 text-xl font-bold leading-tight break-words">
                                {knock
                                    ? t(FW.askedOnDate, { name, date: formatDate(new Date(knock.sentAt), 'day-month-year') })
                                    : t(CW.askName, { name })}
                            </h1>
                            <div role="status">
                                <p dir="auto" data-testid="knock-waiting-line" className="m-0 mb-4 text-base break-words">{line}</p>
                            </div>
                        </>
                    )}
                    {note && <p role="alert" className="m-0 mb-3 text-sm text-bp-ink-danger break-words">{note}</p>}
                    {pending && !cancelled && origin && origin === window.location.origin && <TellMeCard origin={origin} identity={identity} name={name} />}

                    <div className="grid gap-3">
                        {!approved && !closed && !cancelled && (
                            <button type="button" data-testid="knock-waiting-check" className={SECONDARY} disabled={checking} aria-busy={checking} onClick={() => void check()}>
                                {checking ? t('Checking…') : t('Check again')}
                            </button>
                        )}
                        {pending && !cancelled && (confirm === 'cancel' ? (
                            <div className="grid gap-2" data-testid="knock-waiting-cancel-confirm">
                                <p className="m-0 text-sm break-words">{t(FW.cancelConfirmText, { name })}</p>
                                <button type="button" className={PRIMARY} disabled={busy} onClick={() => void doCancel()} data-testid="knock-waiting-cancel-yes">
                                    {busy ? t(FW.cancelling) : t(FW.cancelRequest)}
                                </button>
                                <button type="button" className={SECONDARY} onClick={() => setConfirm(null)}>{t(FW.keepIt)}</button>
                            </div>
                        ) : (
                            <button type="button" data-testid="knock-waiting-cancel" className={SECONDARY} onClick={() => setConfirm('cancel')}>
                                {t(FW.cancelRequest)}
                            </button>
                        ))}
                        {(closed || cancelled) && !approved && (
                            <>
                                {!cancelled && (
                                    <button type="button" data-testid="knock-waiting-ask-again-button" className={PRIMARY} onClick={() => setAskAgain(true)}>
                                        {t(CW.askName, { name })}
                                    </button>
                                )}
                                <button type="button" data-testid="knock-waiting-forget" className={SECONDARY} disabled={busy}
                                    onClick={() => void forget().then(gone => { if (gone) onForgotten(); })}>
                                    {t('Forget this request')}
                                </button>
                            </>
                        )}
                        <button type="button" data-testid="knock-waiting-invite" className={SECONDARY} onClick={onInvite}>{t(CW.haveInvite)}</button>
                        {confirm === 'signin' ? (
                            <div className="grid gap-2" data-testid="knock-waiting-signin-confirm">
                                <p className="m-0 text-sm break-words">{t('Signing in with your account forgets your request to {name} on this browser.', { name })}</p>
                                <button type="button" className={PRIMARY} disabled={busy} data-testid="knock-waiting-signin-yes"
                                    onClick={() => void forget().then(gone => { if (gone) onSignIn(); })}>
                                    {t('Forget this request')}
                                </button>
                                <button type="button" className={SECONDARY} onClick={() => setConfirm(null)}>{t(FW.keepIt)}</button>
                            </div>
                        ) : (
                            <button type="button" data-testid="knock-waiting-signin" className={SECONDARY} onClick={() => setConfirm('signin')}>{t(CW.member)}</button>
                        )}
                        {global && (
                            <a href={global} rel="noopener noreferrer" data-testid="knock-waiting-global" className={`${DOOR} text-bp-ink-brand underline font-semibold`}>
                                {t(CW.lookAround)}
                            </a>
                        )}
                    </div>
                </section>
            </div>
        </main>
    );
}

/**
 * "Tell me when they answer" (DESIGN-web-notifications-fable.md §2.3, §2.4): the reason first, the browser asked only at the
 * tap. Subscribed already (this browser keeps the pin and still has permission): the ✓ line. Where push can't work: the
 * plain words, and on a phone the app's store link above them (Marty, 9 Nov, Decision 3).
 */
function TellMeCard({ origin, identity, name }: { origin: string; identity: BeanPoolIdentity; name: string }) {
    const [state, setState] = useState<{ kind: 'idle' | 'asking' } | { kind: 'on' | 'off'; place: PushPlace; dismissed?: boolean }>(() => {
        const granted = typeof Notification !== 'undefined' && Notification.permission === 'granted';
        return readWebPushPin(origin, identity.publicKey) && granted ? { kind: 'on', place: pushPlace() } : { kind: 'idle' };
    });
    // Called straight from the tap, with nothing awaited first: a browser asks for permission only inside the gesture.
    const tap = () => {
        setState({ kind: 'asking' });
        void tellMeWhenTheyAnswer(origin, identity, currentLanguage()).then(r => {
            if (r.ok) setState({ kind: 'on', place: r.place });
            else if (r.reason === 'dismissed') setState({ kind: 'idle' });
            else setState({ kind: 'off', place: r.place, dismissed: r.reason === 'failed' });
        });
    };
    const off = state.kind === 'off' ? (state.dismissed ? { lines: [t(TW.failed)], getApp: null } : cannotLines(state.place)) : null;
    return (
        <div data-testid="tell-me-card" className="mb-4 p-4 max-[359px]:p-3 rounded-xl border border-nature-200 dark:border-nature-800">
            {state.kind === 'on' ? (
                <div role="status">
                    <p dir="auto" data-testid="tell-me-on" className="m-0 text-base font-bold break-words">{t(TW.granted, { name })}</p>
                    {grantedLine(state.place) && <p dir="auto" className="m-0 mt-1 text-sm text-text-secondary break-words">{grantedLine(state.place)}</p>}
                </div>
            ) : (
                <>
                    <p dir="auto" className="m-0 mb-1 text-base font-bold break-words">{t(TW.title)}</p>
                    <p dir="auto" className="m-0 mb-3 text-sm text-text-secondary break-words">{t(TW.line, { name })}</p>
                    {off ? (
                        <div role="status" data-testid="tell-me-off" className="grid gap-2">
                            {off.getApp && (
                                <a href={off.getApp} rel="noopener noreferrer" data-testid="tell-me-get-app" className={`${PRIMARY} no-underline`}>{t(PEEK_WORDS.getApp)}</a>
                            )}
                            {off.lines.map(line => <p key={line} dir="auto" className="m-0 text-sm break-words">{line}</p>)}
                        </div>
                    ) : (
                        <button type="button" data-testid="tell-me" className={PRIMARY} disabled={state.kind === 'asking'} aria-busy={state.kind === 'asking'} onClick={tap}>
                            {state.kind === 'asking' ? t(TW.asking) : t(TW.button)}
                        </button>
                    )}
                </>
            )}
        </div>
    );
}
