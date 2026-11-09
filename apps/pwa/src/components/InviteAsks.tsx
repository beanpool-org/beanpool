/**
 * A member asks an admin to invite someone (Marty, 3 Nov), on People → Invites; the phone's components/InviteAsks.tsx is
 * the same. `AskAnAdmin`: for a member where only admins invite, a small button and a short sheet, and what they've asked.
 * `InviteAsksToAnswer`: for an owner or admin, each ask with Send invite and No. The node decides each. A small button, no
 * banner: nobody is hassled.
 *
 * What someone typed is always in `Fenced`, as plain text in its own box, and never put into one of the app's sentences.
 * Every control is at least 44 px tall and wraps at 320 px with 1.3× text; the sheet keeps focus inside and Escape closes it.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
    INVITE_ASK_LIMITS, INVITE_ASK_WORDS, formatDate, inviteAskAnswerWords, inviteAskReady, t,
    type InviteAskAnswer, type InviteAskToAnswer, type InviteAskWaiting,
} from '@beanpool/core';
import { askAnAdmin, readAsksToAnswer, readMyAsks, sayNoToAsk, sendInviteForAsk, takeBackAsk } from '../lib/invite-asks';
import { getMyVouching, type MyVouching } from '../lib/api';
import { VouchPresetChoice } from './VouchPresetChoice';
import { useDialogFocus } from './dialog-focus';
import { InvitePictureQueue } from './InvitePictures';

const askedWords = (iso: string) => t(INVITE_ASK_WORDS.asked, { date: formatDate(new Date(iso), 'day-month-year') });

const QUIET = 'min-h-[44px] px-4 rounded-xl border border-nature-300 dark:border-nature-600 bg-white dark:bg-nature-900 text-nature-800 dark:text-nature-100 text-[15px] font-bold cursor-pointer disabled:cursor-default disabled:opacity-60';
const STRONG = 'min-h-[44px] px-[18px] rounded-xl border-none bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on text-[15px] font-extrabold cursor-pointer disabled:cursor-default disabled:opacity-60';
const FIELD = 'w-full min-h-[44px] mt-1.5 mb-3 p-3 rounded-xl border border-nature-300 dark:border-nature-600 bg-white dark:bg-nature-950 text-nature-950 dark:text-white text-[15px] outline-none focus:ring-2 focus:ring-emerald-500';
const CARD = 'mb-3 p-3.5 rounded-2xl border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-900';
const META = 'm-0 text-xs text-nature-600 dark:text-nature-300 break-words';
const LABEL = 'block text-sm font-bold text-nature-950 dark:text-white';
const REFUSAL = 'm-0 mb-3 text-sm leading-relaxed text-amber-700 dark:text-amber-400';

/** Words a person typed, set apart: never read as the app's own, never as markup. */
function Fenced({ name, line }: { name?: string; line: string }) {
    return (
        <div className="mt-2 pl-2.5 border-l-[3px] border-nature-300 dark:border-nature-600" data-testid="invite-ask-fence">
            {name && <p dir="auto" className="m-0 text-base font-bold text-nature-950 dark:text-white break-words">{name}</p>}
            <p dir="auto" className="m-0 text-sm leading-relaxed text-nature-800 dark:text-nature-100 break-words whitespace-pre-wrap">{line}</p>
        </div>
    );
}

function Waiting({ ask, busy, onTakeBack }: { ask: InviteAskWaiting; busy: boolean; onTakeBack: () => void }) {
    return (
        <div className={CARD} data-testid={`invite-ask-waiting-${ask.id}`}>
            <p className={META}>{askedWords(ask.askedAt)}</p>
            <p className={META}>{t(INVITE_ASK_WORDS.waiting)}</p>
            <Fenced name={ask.firstName} line={ask.howKnown} />
            <div className="flex flex-wrap gap-2 mt-3">
                <button type="button" className={QUIET} onClick={onTakeBack} disabled={busy}>{t(INVITE_ASK_WORDS.takeBack)}</button>
            </div>
        </div>
    );
}

function Answered({ answer, onCopy, onShare, note }: { answer: InviteAskAnswer; onCopy: (code: string) => void; onShare: (code: string) => void; note?: ReactNode }) {
    return (
        <div className={CARD} data-testid={`invite-ask-answer-${answer.id}`}>
            <p className={META}>{askedWords(answer.askedAt)}</p>
            <p className="m-0 mt-1.5 text-sm leading-relaxed text-nature-800 dark:text-nature-100 break-words">{inviteAskAnswerWords(answer)}</p>
            {answer.reason && <Fenced line={answer.reason} />}
            {answer.code && (
                <>
                    <p className="m-0 mt-2 font-mono text-base font-extrabold tracking-wider text-nature-950 dark:text-white break-all">{answer.code}</p>
                    <div className="flex flex-wrap gap-2 mt-3">
                        <button type="button" className={QUIET} onClick={() => onCopy(answer.code!)} aria-label={t('Copy invite link')}>{t('📋 Copy')}</button>
                        <button type="button" className={STRONG} onClick={() => onShare(answer.code!)} aria-label={t('Share invite link')}>{t('📤 Share')}</button>
                    </div>
                    {note}
                </>
            )}
        </div>
    );
}

/**
 * The short ask form. ONE form: People → Invites and the Share sheet's "Ask an admin to invite someone" both open this one.
 * `fallback` is where focus goes on close when what opened the form has gone with the same step (the Share menu's Ask item
 * closes with the menu): the Share button, never the page's <body>.
 */
export function AskSheet({ onClose, onSent, fallback }: { onClose: () => void; onSent: () => void; fallback?: () => HTMLElement | null | undefined }) {
    const dialog = useRef<HTMLDivElement | null>(null);
    const first = useRef<HTMLInputElement | null>(null);
    useDialogFocus(dialog, onClose, { initialFocus: () => first.current, fallback });
    const [firstName, setFirstName] = useState('');
    const [howKnown, setHowKnown] = useState('');
    const [busy, setBusy] = useState(false);
    const [refusal, setRefusal] = useState<string | null>(null);
    const send = async (e: FormEvent) => {
        e.preventDefault();
        if (busy || !inviteAskReady(firstName, howKnown)) return;
        setBusy(true);
        const r = await askAnAdmin(firstName, howKnown);
        setBusy(false);
        if (r.ok) onSent(); else setRefusal(r.message ?? t(INVITE_ASK_WORDS.unreachable));
    };
    return (
        <div ref={dialog} className="fixed inset-0 z-[310] flex items-end sm:items-center justify-center" role="dialog" aria-modal="true" aria-labelledby="invite-ask-title" data-testid="invite-ask-sheet" onClick={onClose}
            // Escape in the form closes the form and nothing behind it: a page that closes what it shows on Escape (the Market's
            // open listing listens on window) must not see this one (review of #2872). A press inside the form stops here, before
            // window; the dialog-focus listener on window still closes the form for a press that starts outside it.
            onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
            <div className="absolute inset-0 bg-black/50" />
            <form className="relative w-full sm:max-w-[420px] max-h-[90vh] overflow-y-auto p-4 rounded-t-2xl sm:rounded-2xl bg-oat-50 dark:bg-nature-950" onClick={e => e.stopPropagation()} onSubmit={e => void send(e)}>
                <h2 id="invite-ask-title" tabIndex={-1} className="m-0 mb-1.5 text-lg font-extrabold text-nature-950 dark:text-white outline-none">{t(INVITE_ASK_WORDS.button)}</h2>
                <p className="m-0 mb-3 text-[13px] leading-relaxed text-nature-600 dark:text-nature-300">{t(INVITE_ASK_WORDS.help)}</p>
                <label className={LABEL}>
                    {t(INVITE_ASK_WORDS.firstName)}
                    <input ref={first} className={FIELD} value={firstName} onChange={e => setFirstName(e.target.value)} maxLength={INVITE_ASK_LIMITS.firstName} autoComplete="off" required data-testid="invite-ask-first-name" />
                </label>
                <label className={LABEL}>
                    {t(INVITE_ASK_WORDS.howKnown)}
                    <input className={FIELD} value={howKnown} onChange={e => setHowKnown(e.target.value)} maxLength={INVITE_ASK_LIMITS.howKnown} autoComplete="off" required data-testid="invite-ask-how-known" />
                </label>
                {refusal && <p role="alert" className={REFUSAL}>{refusal}</p>}
                <div className="flex flex-wrap gap-2">
                    <button type="submit" className={STRONG} disabled={busy || !inviteAskReady(firstName, howKnown)} data-testid="invite-ask-send">{t(INVITE_ASK_WORDS.send)}</button>
                    <button type="button" className={QUIET} onClick={onClose}>{t('Cancel')}</button>
                </div>
            </form>
        </div>
    );
}

/** For a member where only admins invite: the small button, the short sheet, and what they've asked. */
export function AskAnAdmin({ onCopy, onShare, noteFor }: {
    onCopy: (code: string) => void;
    onShare: (code: string) => void;
    /** What to show under an answered invite's buttons (the page's "Invite message copied" note), by its code. */
    noteFor?: (code: string) => ReactNode;
}) {
    const [mine, setMine] = useState<{ waiting: InviteAskWaiting[]; answers: InviteAskAnswer[] } | null>(null);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [refusal, setRefusal] = useState<string | null>(null);
    const load = useCallback(async () => {
        const read = await readMyAsks();
        if (read) setMine(read);
    }, []);
    useEffect(() => { void load(); }, [load]);
    const takeBack = async (id: string) => {
        setBusy(true);
        const r = await takeBackAsk(id);
        setBusy(false);
        setRefusal(r.ok ? null : r.message ?? t(INVITE_ASK_WORDS.unreachable));
        void load();
    };
    const shown = (mine?.waiting.length ?? 0) + (mine?.answers.length ?? 0) > 0;
    return (
        <div className="mt-5" data-testid="invite-ask">
            <button type="button" className={QUIET} onClick={() => setOpen(true)} data-testid="invite-ask-open">{t(INVITE_ASK_WORDS.button)}</button>
            {refusal && <p role="alert" className={`${REFUSAL} mt-3`}>{refusal}</p>}
            {shown && <h3 className="m-0 mt-5 mb-3 text-[15px] font-extrabold text-nature-950 dark:text-white">{t(INVITE_ASK_WORDS.mine)}</h3>}
            {mine?.waiting.map(ask => <Waiting key={ask.id} ask={ask} busy={busy} onTakeBack={() => void takeBack(ask.id)} />)}
            {mine?.answers.map(answer => <Answered key={answer.id} answer={answer} onCopy={onCopy} onShare={onShare} note={answer.code ? noteFor?.(answer.code) : undefined} />)}
            {/* The QR pictures Share sends with these invites, made now so the tap only has to share. */}
            <InvitePictureQueue codes={mine?.answers.map(answer => answer.code) ?? []} />
            {open && <AskSheet onClose={() => setOpen(false)} onSent={() => { setOpen(false); void load(); }} />}
        </div>
    );
}

function AskCard({ ask, busy, myVouching, onSend, onNo }: {
    ask: InviteAskToAnswer; busy: boolean; myVouching: MyVouching | null;
    onSend: (vouch?: number) => void; onNo: (reason: string) => void;
}) {
    const [saying, setSaying] = useState(false);
    const [reason, setReason] = useState('');
    const [vouchPreset, setVouchPreset] = useState<number | null>(null);
    return (
        <div className={CARD} data-testid={`invite-ask-${ask.id}`}>
            <p dir="auto" className="m-0 text-[15px] font-extrabold text-nature-950 dark:text-white break-words">{t(INVITE_ASK_WORDS.askedBy, { name: ask.askerCallsign })}</p>
            <p className={META}>{askedWords(ask.askedAt)}</p>
            <Fenced name={ask.firstName} line={ask.howKnown} />
            {myVouching?.voucher && (
                <div className="mt-3">
                    <VouchPresetChoice
                        value={vouchPreset}
                        onChange={setVouchPreset}
                        budgetLeft={myVouching.budget?.left ?? 0}
                        budgetTotal={myVouching.budget?.level ?? 0}
                        noLimit={myVouching.noLimit === true}
                    />
                </div>
            )}
            {saying ? (
                <form className="mt-3" onSubmit={e => { e.preventDefault(); onNo(reason); }}>
                    <label className={LABEL}>
                        {t(INVITE_ASK_WORDS.reason)}
                        <input className={FIELD} value={reason} onChange={e => setReason(e.target.value)} maxLength={INVITE_ASK_LIMITS.reason} autoComplete="off" autoFocus data-testid={`invite-ask-reason-${ask.id}`} />
                    </label>
                    <div className="flex flex-wrap gap-2">
                        <button type="submit" className={STRONG} disabled={busy} data-testid={`invite-ask-send-no-${ask.id}`}>{t(INVITE_ASK_WORDS.say)}</button>
                        <button type="button" className={QUIET} onClick={() => setSaying(false)} disabled={busy}>{t('Cancel')}</button>
                    </div>
                </form>
            ) : (
                <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" className={STRONG} onClick={() => onSend(vouchPreset ?? undefined)} disabled={busy} data-testid={`invite-ask-invite-${ask.id}`}>{t(INVITE_ASK_WORDS.sendInvite)}</button>
                    <button type="button" className={QUIET} onClick={() => setSaying(true)} disabled={busy} data-testid={`invite-ask-no-${ask.id}`}>{t(INVITE_ASK_WORDS.say)}</button>
                </div>
            )}
        </div>
    );
}

/** For an owner or admin: the asks waiting, oldest first. The node answers anyone else 403, and there is no section. */
export function InviteAsksToAnswer() {
    const [asks, setAsks] = useState<InviteAskToAnswer[] | null>(null);
    const [myVouching, setMyVouching] = useState<MyVouching | null>(null);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const [refusal, setRefusal] = useState<string | null>(null);
    const load = useCallback(async () => {
        setAsks(await readAsksToAnswer());
        try {
            setMyVouching(await getMyVouching());
        } catch {
            setMyVouching(null);
        }
    }, []);
    useEffect(() => { void load(); }, [load]);
    const answer = async (go: Promise<{ ok: true } | { ok: false; message: string | null }>, done: string) => {
        setBusy(true);
        const r = await go;
        setBusy(false);
        setNote(r.ok ? done : null);
        setRefusal(r.ok ? null : r.message ?? t(INVITE_ASK_WORDS.unreachable));
        void load();
    };
    if (!asks?.length && !note && !refusal) return null;
    return (
        <section className="mb-6" data-testid="invite-asks-to-answer" aria-label={t(INVITE_ASK_WORDS.toAnswer)}>
            <h2 className="text-xl font-bold mb-2 text-nature-950 dark:text-white">{t(INVITE_ASK_WORDS.toAnswer)}</h2>
            <p className="m-0 mb-3 text-[13px] leading-relaxed text-nature-600 dark:text-nature-300">{t(INVITE_ASK_WORDS.toAnswerHelp)}</p>
            {note && <p role="status" className="m-0 mb-3 text-sm leading-relaxed text-nature-800 dark:text-nature-100">{note}</p>}
            {refusal && <p role="alert" className={REFUSAL}>{refusal}</p>}
            {asks?.map(ask => (
                <AskCard
                    key={ask.id}
                    ask={ask}
                    busy={busy}
                    myVouching={myVouching}
                    onSend={(vouch) => void answer(sendInviteForAsk(ask.id, vouch), t(INVITE_ASK_WORDS.sent))}
                    onNo={reason => void answer(sayNoToAsk(ask.id, reason), t(INVITE_ASK_WORDS.told))}
                />
            ))}
        </section>
    );
}
