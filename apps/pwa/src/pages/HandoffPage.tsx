/**
 * The receiving half of the account handoff (DESIGN-global-yes-join-fable.md §2.1, slice Y1), at `/app?door=handoff`: this
 * community's page, opened by the page that holds a member's account (global's Home, lib/handoff.ts) after a member here
 * said yes to that account's request. In order, and nothing is kept until the person taps Join:
 *   1. `ready` to `window.opener`, at the `from` the address names only; then one message, from the opener, at `from`, with
 *      this handoff's nonce, carrying a whole account (lib/handoff.ts accountFrom); 60 s with none, and it stops listening;
 *   2. this browser can keep an account here at all; if not, the storage sentence, and `no-storage`;
 *   3. a signed status read at this community with that key: only a yes goes on, since the invite is bound to the key; any
 *      other answer is "This account has no yes here." and `refused`, and the key is dropped;
 *   4. no other account here (a member's, a key waiting on its own request, a join part way through): else "This browser
 *      already has an account here." and `held`. Asked after the yes, so a page that opens this door with a key nobody
 *      here said yes to learns nothing about this browser;
 *   5. "Join {name} as {callsign}?", naming the page it came from, with the name the request sent (editable) and the
 *      photo from there as a tickbox, off; Join keeps the key as the waiting key, marked established (lib/knock-key.ts
 *      waitWithRestoredKey, the guarded save), and the welcome page joins with it through the invite path; the page it came
 *      from hears `joined` once the key is a member here (lib/handoff.ts handoffJoined). Not mine: `declined`, nothing kept.
 */
import { useEffect, useRef, useState } from 'react';
import { communityCardName, t, type CommunityCard } from '@beanpool/core';
import { getCommunityCard } from '../lib/api';
import {
    HANDOFF_LISTEN_MS, accountFrom, answerMessage, awaitHandoffJoin, dropOpener, readyMessage, type HandoffAnswer,
} from '../lib/handoff';
import {
    IdentityHeldError, IdentityStoreUnavailableError, NO_STORAGE_SENTENCE, STORE_WOULD_NOT_OPEN_SENTENCE, SentJoinWaitingError,
    identityStoreProblem, importIdentity, loadIdentityStrict, loadInviteSent, loadPendingJoin, type BeanPoolIdentity,
} from '../lib/identity';
import { KNOCK_CALLSIGN_CHARS, KNOCK_MESSAGES, readKnockStatus } from '../lib/knock';
import { waitWithRestoredKey } from '../lib/knock-key';
import { resolveAvatarUrl } from '../lib/avatar';
import { thisCommunityOrigin } from '../components/AskHere';
import { LanguageSwitch } from '../components/LanguageSwitch';
import { keyLineWords } from '../components/key-lines';

const DOOR = 'block w-full min-h-[48px] px-4 py-3 rounded-xl text-center text-base font-bold break-words no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-info';
const PRIMARY = `${DOOR} border-none bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on cursor-pointer disabled:cursor-default disabled:opacity-60`;
const SECONDARY = `${DOOR} bg-transparent border border-bp-ink-info text-bp-ink-info cursor-pointer disabled:cursor-default disabled:opacity-60`;

/** The guarded save's rule here: refused while any join sent from this browser waits to be settled. */
const SAVE_GUARD = { refuseWhileSentJoinWaits: { except: null } };

type View =
    | { kind: 'listening' }
    | { kind: 'checking' }
    | { kind: 'nothing' }
    | { kind: 'no-storage'; sentence: string }
    | { kind: 'refused'; sentence: string }
    | { kind: 'held' }
    | { kind: 'declined' }
    | { kind: 'confirm'; account: BeanPoolIdentity; photo: string | null; invite: string; member: boolean; busy: boolean; error: string | null };

export function HandoffPage({ handoff, onOpen, onJoin, onMember }: {
    handoff: { nonce: string; from: string };
    /** Leave this door for the page as it is: the account held here, or the doors a stranger sees. */
    onOpen: () => void;
    /** Join: the key is kept as the waiting key (established); the welcome page redeems `invite` with it. */
    onJoin: (yes: { account: BeanPoolIdentity; invite: string; name: string }) => void;
    /** The key is a member here already (it joined elsewhere) and is kept here now: the member app. */
    onMember: (member: BeanPoolIdentity) => void;
}) {
    const { nonce, from } = handoff;
    const fromHost = from.replace(/^https:\/\//, '');
    const origin = thisCommunityOrigin();
    const [card, setCard] = useState<CommunityCard | null>(null);
    const [view, setView] = useState<View>({ kind: 'listening' });
    const [callsign, setCallsign] = useState('');
    const [usePhoto, setUsePhoto] = useState(false);
    // The window that opened this one, read once: the only one this page talks to, and only at `from`.
    const opener = useRef<Window | null>(typeof window !== 'undefined' ? window.opener as Window | null : null);

    // A refusal is this page's last word to the one that opened it: said, then the link goes (lib/handoff.ts dropOpener).
    // `joined` is said by the welcome page once the yes has made the key a member (handoffJoined), which drops it too.
    const answer = (a: HandoffAnswer) => {
        try { opener.current?.postMessage(answerMessage(nonce, a), from); } catch { /* its tab has gone */ }
        opener.current = null;
        dropOpener();
    };

    useEffect(() => {
        let alive = true;
        getCommunityCard().then(c => { if (alive && c) setCard(c); }).catch(() => {});
        return () => { alive = false; };
    }, []);

    useEffect(() => {
        const from_ = opener.current;
        if (!from_) { setView({ kind: 'nothing' }); return; }
        let listening = true;
        const stop = () => {
            listening = false;
            window.removeEventListener('message', onMessage);
            clearTimeout(timer);
        };
        const onMessage = (event: MessageEvent) => {
            if (!listening) return;
            void accountFrom(event, opener.current, from, nonce).then((got) => {
                if (!got || !listening) return;
                stop();
                void check(got.account, got.photo);
            });
        };
        window.addEventListener('message', onMessage);
        const timer = setTimeout(() => { if (listening) { stop(); setView({ kind: 'nothing' }); } }, HANDOFF_LISTEN_MS);
        // Nothing secret in it, and only to the page the address says opened this one.
        try { from_.postMessage(readyMessage(nonce), from); } catch { stop(); setView({ kind: 'nothing' }); }
        return stop;
        // Once per page: the handoff is read from the address at load.
    }, []);

    async function check(account: BeanPoolIdentity, photo: string | null) {
        setView({ kind: 'checking' });
        const problem = await identityStoreProblem().catch(() => 'failed' as const);
        if (problem) {
            answer('no-storage');
            setView({ kind: 'no-storage', sentence: keyLineWords(problem === 'absent' ? NO_STORAGE_SENTENCE : STORE_WOULD_NOT_OPEN_SENTENCE) });
            return;
        }
        const status = await readKnockStatus(origin, account);
        if (!status.ok || status.value.status !== 'approved') {
            answer('refused');
            const unreachable = !status.ok && status.kind === 'unreachable';
            setView({ kind: 'refused', sentence: unreachable ? t(KNOCK_MESSAGES.unreachable) : t('This account has no yes here.') });
            return;
        }
        let held: BeanPoolIdentity | null;
        try {
            held = await loadIdentityStrict();
            const pending = await loadPendingJoin();
            const sent = await loadInviteSent();
            if (!held && (pending || sent)) held = pending?.identity ?? sent?.identity ?? null;
        } catch {
            answer('no-storage');
            setView({ kind: 'no-storage', sentence: keyLineWords(STORE_WOULD_NOT_OPEN_SENTENCE) });
            return;
        }
        const member = status.value.member === true;
        if (held && held.publicKey !== account.publicKey) {
            answer('held');
            setView({ kind: 'held' });
            return;
        }
        if (held && member) {
            // This account is here already, and a member: nothing to do but say so.
            answer('joined');
            onOpen();
            return;
        }
        setCallsign(Array.from(account.callsign).slice(0, KNOCK_CALLSIGN_CHARS).join(''));
        setUsePhoto(false);
        setView({ kind: 'confirm', account, photo, invite: status.value.invite, member, busy: false, error: null });
    }

    const name = card ? communityCardName(card, { t }) : (origin ? origin.replace(/^https:\/\//, '') : t('this community'));

    async function join() {
        if (view.kind !== 'confirm' || view.busy) return;
        const typed = callsign.replace(/\s+/g, ' ').trim();
        if (Array.from(typed).length < 2) {
            setView({ ...view, error: t('Please give a name of at least 2 characters.') });
            return;
        }
        setView({ ...view, busy: true, error: null });
        const account = { ...view.account, callsign: typed };
        try {
            if (view.member) {
                // A member here already (it joined on another device): kept here as that member.
                await importIdentity(account, SAVE_GUARD);
                answer('joined');
                onMember(account);
                return;
            }
            await waitWithRestoredKey(account, SAVE_GUARD);
        } catch (e) {
            if (e instanceof IdentityHeldError || e instanceof SentJoinWaitingError) {
                answer('held');
                setView({ kind: 'held' });
                return;
            }
            if (e instanceof IdentityStoreUnavailableError) {
                answer('no-storage');
                setView({ kind: 'no-storage', sentence: keyLineWords(e.reason === 'absent' ? NO_STORAGE_SENTENCE : STORE_WOULD_NOT_OPEN_SENTENCE) });
                return;
            }
            setView({ ...view, busy: false, error: t("Couldn't keep your account on this browser. Please try again.") });
            return;
        }
        if (opener.current) awaitHandoffJoin(account.publicKey, opener.current, from, nonce, usePhoto ? view.photo : null);
        onJoin({ account, invite: view.invite, name });
    }

    function notMine() {
        answer('declined');
        setView({ kind: 'declined' });
    }

    const openButton = (
        <button type="button" data-testid="handoff-open" className={SECONDARY} onClick={onOpen}>{t('Open {name}', { name })}</button>
    );

    let body;
    switch (view.kind) {
        case 'listening':
        case 'checking':
            body = <p role="status" data-testid="handoff-waiting" className="m-0 text-base break-words">{t('Bringing your account…')}</p>;
            break;
        case 'nothing':
            body = (
                <>
                    <p data-testid="handoff-nothing" className="m-0 mb-4 text-base break-words">
                        {t('Nothing came from the page that opened this one. Go back there to try again, or to see the other ways to join.')}
                    </p>
                    {openButton}
                </>
            );
            break;
        case 'no-storage':
            body = <><p role="alert" data-testid="handoff-no-storage" className="m-0 mb-4 text-base break-words">{view.sentence}</p>{openButton}</>;
            break;
        case 'refused':
            body = <><p role="alert" data-testid="handoff-refused" className="m-0 mb-4 text-base break-words">{view.sentence}</p>{openButton}</>;
            break;
        case 'held':
            body = <><p role="alert" data-testid="handoff-held" className="m-0 mb-4 text-base break-words">{t('This browser already has an account here.')}</p>{openButton}</>;
            break;
        case 'declined':
            body = <><p role="status" data-testid="handoff-declined" className="m-0 mb-4 text-base break-words">{t('Nothing was kept here. You can close this tab.')}</p>{openButton}</>;
            break;
        case 'confirm': {
            const shown = callsign.replace(/\s+/g, ' ').trim() || view.account.callsign;
            const photoSrc = view.photo ? resolveAvatarUrl(view.photo) : null;
            body = (
                <form data-testid="handoff-confirm" onSubmit={(e) => { e.preventDefault(); void join(); }}>
                    <h1 dir="auto" className="m-0 mb-2 text-2xl font-bold leading-tight break-words">{t('Join {name} as {callsign}?', { name, callsign: shown })}</h1>
                    <p dir="auto" data-testid="handoff-from" className="m-0 mb-4 text-base break-words">
                        {t('Your account from {host} comes with you. Your 12 words stay the same.', { host: fromHost })}
                    </p>
                    <label htmlFor="handoff-callsign" className="block mb-1 text-sm font-semibold break-words">{t('Your name in {name}', { name })}</label>
                    <input id="handoff-callsign" data-testid="handoff-callsign" type="text" value={callsign} maxLength={KNOCK_CALLSIGN_CHARS} autoComplete="nickname"
                        onChange={(e) => setCallsign(e.target.value)}
                        className="block w-full min-h-[48px] mb-3 px-3 py-2 rounded-xl border border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-950 text-text-primary text-base" />
                    {photoSrc && (
                        <label className="flex items-center gap-3 mb-4 min-h-[48px] cursor-pointer break-words" data-testid="handoff-photo">
                            <input type="checkbox" data-testid="handoff-photo-box" checked={usePhoto} onChange={(e) => setUsePhoto(e.target.checked)} className="w-6 h-6 shrink-0" />
                            <img src={photoSrc} alt="" width={40} height={40} className="w-10 h-10 rounded-full object-cover shrink-0" />
                            <span className="min-w-0 text-base">{t('Use my photo from {host}', { host: fromHost })}</span>
                        </label>
                    )}
                    {view.error && <p role="alert" data-testid="handoff-error" className="m-0 mb-3 text-sm text-bp-ink-danger break-words">{view.error}</p>}
                    <div className="grid gap-3">
                        <button type="submit" data-testid="handoff-join" className={PRIMARY} disabled={view.busy} aria-busy={view.busy}>
                            {view.busy ? t('Joining…') : t('Join {name}', { name })}
                        </button>
                        <button type="button" data-testid="handoff-not-mine" className={SECONDARY} disabled={view.busy} onClick={notMine}>{t('Not mine')}</button>
                    </div>
                </form>
            );
            break;
        }
    }

    return (
        <main data-testid="handoff" className="page-surface min-h-screen p-4 text-text-primary">
            <div className="max-w-lg mx-auto">
                <div className="flex justify-end mb-2"><LanguageSwitch /></div>
                <section className="p-5 max-[359px]:px-4 rounded-2xl bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 shadow-sm">
                    {body}
                </section>
            </div>
        </main>
    );
}
