/**
 * To check (slice K4; DESIGN-local-knowledge-fable.md §5 as amended §A5): owners and admins answer members' suggestions of Local
 * knowledge here, reached from Learn's amber "3 to check ›", Home's first row and the bell's "Local knowledge to check: 3". The
 * phone's is the same pair of screens (apps/native app/learn/check.tsx, check/[id].tsx).
 *
 * The list: "Waiting ({n})", the longest waiting first: title · New or Fix · "from {name}" (or "gathered with {assistant} for
 * {name}") · how long. One opened: the page as members would see it, "Before you approve" (three lines), for an assistant's
 * draft the chip and the tick the button waits for, then Approve · Edit first (the form, then Approve) · Not this one (a reason
 * from core's list and a few words the writer reads). No bulk approve: each is opened.
 */
import { useEffect, useState } from 'react';
import {
    KNOWLEDGE_DECLINE_REASONS, KNOWLEDGE_LIMITS, t, timeAgo, upperCase, type KnowledgeDraftToCheck, type KnowledgeDraftWhole,
} from '@beanpool/core';
import { approveLearnDraft, declineLearnDraft, getLearnDraft, getLearnToCheck, learnRefusalText, safeSourceUrl, sourceHost, topicEmoji, topicLabel } from '../lib/learn';
import { LearnForm } from './LearnForm';
import { CHIP, PAGE_BOX, BOX_LABEL } from './market-card-shell';

const MUTED = 'text-nature-600 dark:text-nature-300';
const TOPIC_CHIP = `${CHIP} bg-bp-chip-learn-tint text-bp-chip-learn-ink`;
const BUTTON = 'w-full min-h-[48px] rounded-xl px-4 py-2.5 font-bold disabled:opacity-60 disabled:cursor-not-allowed';
const SECOND = `${BUTTON} border border-nature-300 dark:border-nature-600 bg-white dark:bg-nature-900 text-nature-900 dark:text-white`;

function Failed({ onAgain }: { onAgain: () => void }) {
    return (
        <div role="alert" className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 p-3 text-sm text-red-700 dark:text-red-300">
            <p className="m-0 mb-2">{t("Couldn't load Learn. Check your connection and try again.")}</p>
            <button type="button" onClick={onAgain} className="min-h-[44px] px-3 rounded-lg border border-red-300 dark:border-red-700 font-bold">{t('Try again')}</button>
        </div>
    );
}

const kindWord = (kind: string) => (kind === 'fix' ? t('Fix') : t('New', undefined, 'a suggestion of a new page of Local knowledge, not a fix'));
/** How long it has waited: "2 hours ago" (core timeAgo takes the time gone by, not a date). */
const waited = (iso: string) => timeAgo(Math.max(0, Date.now() - (Date.parse(iso) || Date.now())));
const fromWords = (d: KnowledgeDraftToCheck) => (d.assistant
    ? t('gathered with {assistant} for {name}', { assistant: d.assistant, name: d.from.name })
    : t('from {name}', { name: d.from.name }));

/** The list of what waits. */
export function LearnCheckList({ onOpen }: { onOpen: (id: string) => void }) {
    const [list, setList] = useState<{ drafts: KnowledgeDraftToCheck[]; total: number } | 'failed' | null>(null);
    const [tries, setTries] = useState(0);
    useEffect(() => {
        let live = true;
        getLearnToCheck().then((l) => { if (live) setList(l); }, () => { if (live) setList('failed'); });
        return () => { live = false; };
    }, [tries]);
    if (list === 'failed') return <Failed onAgain={() => setTries((n) => n + 1)} />;
    if (!list) return <p className={MUTED}>{t('Loading...')}</p>;
    if (list.drafts.length === 0) return <p data-testid="learn-check-empty" className={`py-4 ${MUTED}`}>{t('Nothing to check.')}</p>;
    return (
        <section data-testid="learn-check-list" className="pt-2">
            <h2 className="m-0 mb-2 text-sm font-extrabold text-nature-800 dark:text-nature-100">{t('Waiting ({n})', { n: list.total })}</h2>
            <div className="flex flex-col gap-2">
                {list.drafts.map((d) => (
                    <button key={d.id} type="button" data-testid="learn-check-row" onClick={() => onOpen(d.id)}
                        className="text-start rounded-[14px] border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-900 p-3 flex flex-col gap-1 cursor-pointer hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-learn">
                        <span dir="auto" className="font-bold text-nature-900 dark:text-white break-words"><span aria-hidden="true">{topicEmoji(d.topic)} </span>{d.title}</span>
                        <span className={`text-sm ${MUTED} break-words flex flex-wrap gap-x-2`}><span className="font-bold">{kindWord(d.kind)}</span><span>{fromWords(d)}</span><span>{waited(d.createdAt)}</span></span>
                    </button>
                ))}
            </div>
        </section>
    );
}

/** One suggestion, whole, and its answer. `onAnswered` returns to the list once it is answered (or was already). */
export function LearnCheckOne({ id, onAnswered, onEditing }: { id: string; onAnswered: (said: string) => void; onEditing?: (editing: boolean) => void }) {
    const [draft, setDraft] = useState<KnowledgeDraftWhole | null | 'failed' | undefined>(undefined);
    const [tries, setTries] = useState(0);
    const [ticked, setTicked] = useState(false);
    const [mode, setMode] = useState<'read' | 'edit' | 'no'>('read');
    const [reason, setReason] = useState<string | null>(null);
    const [words, setWords] = useState('');
    const [busy, setBusy] = useState(false);
    const [refusal, setRefusal] = useState<string | null>(null);
    useEffect(() => {
        let live = true;
        setDraft(undefined);
        getLearnDraft(id).then((d) => { if (live) setDraft(d); }, () => { if (live) setDraft('failed'); });
        return () => { live = false; };
    }, [id, tries]);
    useEffect(() => { onEditing?.(mode === 'edit'); }, [mode, onEditing]);

    if (draft === 'failed') return <Failed onAgain={() => setTries((n) => n + 1)} />;
    if (draft === undefined) return <p className={MUTED}>{t('Loading...')}</p>;
    if (draft === null) {
        return <p data-testid="learn-check-gone" className={`py-4 ${MUTED}`}>{t('This one was already answered.')}</p>;
    }
    const d = draft;
    const mayApprove = !d.needsSourcesTicked || ticked;
    const act = async (go: () => Promise<unknown>, said: string) => {
        if (busy) return;
        setBusy(true);
        setRefusal(null);
        try {
            await go();
            onAnswered(said);
        } catch (e) {
            setRefusal(learnRefusalText(e));
        } finally {
            setBusy(false);
        }
    };

    if (mode === 'edit') {
        return (
            <LearnForm use="approve" initial={{ title: d.title, body: d.body, topic: d.topic, place: d.place ?? '', sources: d.sources, photos: d.photos, lang: d.lang ?? undefined }}
                onSend={async (edits) => {
                    await approveLearnDraft(d.id, { edits: { ...edits, lang: d.lang ?? undefined }, checkedSources: d.needsSourcesTicked });
                    onAnswered(t('Approved. It is in Learn.'));
                }} />
        );
    }

    return (
        <article data-testid="learn-check-one" className="flex flex-col gap-3 pt-2 pb-4">
            <div className="flex flex-wrap items-center gap-1">
                <span className={TOPIC_CHIP}>{upperCase(topicLabel(d.topic))}</span>
                <span className={TOPIC_CHIP}>{upperCase(kindWord(d.kind))}</span>
                {d.assistant && <span data-testid="learn-check-gathered" className={TOPIC_CHIP}>{upperCase(t('Gathered with the assistant'))}</span>}
            </div>
            <h2 dir="auto" className="m-0 text-xl font-extrabold leading-snug text-nature-950 dark:text-white break-words">{d.title}</h2>
            <p className={`m-0 text-sm ${MUTED} break-words flex flex-wrap gap-x-2`}><span>{fromWords(d)}</span><span>{waited(d.createdAt)}</span></p>
            {d.note && (
                <section className={PAGE_BOX}>
                    <h3 className={BOX_LABEL.muted}>{t('What changed')}</h3>
                    <p dir="auto" className="m-0 text-sm break-words">{d.note}</p>
                </section>
            )}
            <div dir="auto" data-testid="learn-check-body" className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-nature-900 dark:text-nature-50">{d.body}</div>
            {d.place && <p dir="auto" className="m-0 text-sm font-bold text-nature-800 dark:text-nature-100 break-words">{t('Where: {place}', { place: d.place })}</p>}
            {d.photos.length > 0 && (
                <div className="flex flex-col gap-2">
                    {d.photos.map((src, i) => (src.startsWith('data:image/') ? <img key={i} src={src} alt="" className="w-full aspect-[4/3] object-cover rounded-xl" /> : null))}
                </div>
            )}
            {d.sources.length > 0 && (
                <section data-testid="learn-check-sources" className={PAGE_BOX}>
                    <h3 className={BOX_LABEL.muted}>{t('Sources')}</h3>
                    <ul className="m-0 p-0 list-none flex flex-col gap-1">
                        {d.sources.map((s, i) => {
                            const href = safeSourceUrl(s.url);
                            const host = sourceHost(s.url);
                            const inner = (
                                <span className="min-w-0 flex-1">
                                    <span dir="auto" className="block font-bold text-sm break-words">{s.label || host}</span>
                                    <span className={`block text-xs break-all ${MUTED}`}>{host}</span>
                                </span>
                            );
                            return (
                                <li key={`${i}-${s.url}`}>
                                    {href
                                        ? <a href={href} target="_blank" rel="noopener noreferrer" className="flex items-start gap-2 min-h-[44px] py-1 text-bp-ink-learn hover:underline">{inner}<span aria-hidden="true">↗</span></a>
                                        : <div className="flex items-start gap-2 min-h-[44px] py-1">{inner}</div>}
                                </li>
                            );
                        })}
                    </ul>
                </section>
            )}
            <section className={PAGE_BOX}>
                <h3 className={BOX_LABEL.muted}>{t('Before you approve')}</h3>
                <ul className="m-0 ps-5 text-sm text-nature-800 dark:text-nature-100 flex flex-col gap-1">
                    <li>{t("It's about a place, a service or how to do something, not a private person.")}</li>
                    <li>{t("It's in the writer's own words, not copied.")}</li>
                    <li>{t("You believe it's right, or the sources say so.")}</li>
                </ul>
            </section>
            {d.needsSourcesTicked && (
                <label className="flex items-start gap-3 min-h-[44px] text-sm font-bold text-nature-900 dark:text-white cursor-pointer">
                    <input type="checkbox" data-testid="learn-check-tick" checked={ticked} onChange={(e) => setTicked(e.target.checked)} className="mt-0.5 w-5 h-5 shrink-0" />
                    <span>{t('I opened the sources and they say this.')}</span>
                </label>
            )}
            {mode === 'no' ? (
                <fieldset data-testid="learn-check-no" className="m-0 p-0 border-0 min-w-0 flex flex-col gap-2">
                    <legend className="mb-2 font-extrabold text-nature-900 dark:text-white">{t('Why not?')}</legend>
                    {KNOWLEDGE_DECLINE_REASONS.map((r) => (
                        <label key={r.id} className="flex items-center gap-3 min-h-[44px] text-sm text-nature-900 dark:text-white cursor-pointer">
                            <input type="radio" name="learn-no-reason" value={r.id} checked={reason === r.id} onChange={() => setReason(r.id)} className="w-5 h-5 shrink-0" />
                            <span>{t(r.label)}</span>
                        </label>
                    ))}
                    <label htmlFor="learn-no-words" className={`text-sm font-bold ${MUTED}`}>{t('Add a few words (the writer reads them)')}</label>
                    <textarea id="learn-no-words" data-testid="learn-check-no-words" value={words} maxLength={KNOWLEDGE_LIMITS.reasonWords} rows={3} dir="auto"
                        onChange={(e) => setWords(e.target.value)}
                        className="w-full py-2 px-3 rounded-xl border border-nature-200 dark:border-nature-600 bg-white dark:bg-nature-900 text-nature-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-bp-ink-learn" />
                    {refusal && <p role="alert" className="m-0 text-sm font-bold text-red-700 dark:text-red-300">{refusal}</p>}
                    <button type="button" data-testid="learn-check-no-send" disabled={!reason || busy}
                        onClick={() => reason && void act(() => declineLearnDraft(d.id, reason, words), t('Answered. The writer is told.'))}
                        className={`${BUTTON} bg-bp-cta-fill hover:bg-bp-cta-hover text-bp-cta-on`}>{t('Send')}</button>
                    <button type="button" onClick={() => setMode('read')} className={SECOND}>{t('Back')}</button>
                </fieldset>
            ) : (
                <div className="flex flex-col gap-2">
                    <p className={`m-0 text-xs ${MUTED}`}>{t('Approving adds it to Learn and announces it in the Pulse.')}</p>
                    {refusal && <p role="alert" className="m-0 text-sm font-bold text-red-700 dark:text-red-300">{refusal}</p>}
                    <button type="button" data-testid="learn-check-approve" disabled={!mayApprove || busy}
                        onClick={() => void act(() => approveLearnDraft(d.id, { checkedSources: d.needsSourcesTicked }), t('Approved. It is in Learn.'))}
                        className={`${BUTTON} bg-bp-cta-fill hover:bg-bp-cta-hover text-bp-cta-on`}>{t('Approve')}</button>
                    <button type="button" data-testid="learn-check-edit" disabled={!mayApprove || busy} onClick={() => setMode('edit')} className={SECOND}>{t('Edit first')}</button>
                    <button type="button" data-testid="learn-check-not" disabled={busy} onClick={() => setMode('no')} className={SECOND}>{t('Not this one')}</button>
                </div>
            )}
        </article>
    );
}
