/**
 * To check (slice K4; DESIGN-local-knowledge-fable.md §5 as amended §A5): owners and admins answer members' suggestions of Local
 * knowledge here, reached from Learn's amber "3 to check ›", Home's first row and the bell's "Local knowledge to check: 3". The
 * phone's is the same pair of screens (apps/native app/learn/check.tsx, check/[id].tsx).
 *
 * The list: "Waiting ({n})", the longest waiting first: title · New or Fix · "from {name}" (or "gathered with {assistant} for
 * {name}") · how long. One opened: the page as members would see it, "Before you approve" (three lines), for an assistant's
 * draft the chip and the tick the button waits for, then Approve · Edit first (the form, then Approve) · Not this one (a reason
 * from core's list and a few words the writer reads). No bulk approve: each is opened.
 *
 * Slice K5: a fix shows "What changed" (its note), then only the parts its member changed, each as "Now" beside "Suggested"
 * (`changed`; the note alone says so), a part the page changed under since marked amber (`pageChanged`: Approve is refused
 * until "Edit first" chooses those words). Under the list, "Not checked for a year ({n})": information, never a count in the bell.
 *
 * Learn's tags (16 Nov 2026): a suggestion shows its tags under its place; a fix's changed tags are a part like its words, "Now"
 * beside "Suggested" (`freeTagsChanged`, the node's apart from `changed`), marked amber when the page's own changed under it
 * (`freeTagsPageChanged`); "Edit first" opens on them and sends them.
 *
 * Pictures (Damo's ask; Marty, 16 Nov 2026: "Yes, through the upload link only, the checker approves it"): a suggestion's
 * pictures, a member's or ones an assistant uploaded, each show with Remove photo (and Keep this photo once removed) before
 * Approve. Approve sends back only the kept ones, so only those are published; "Edit first" opens on the kept ones. Nothing a
 * draft brings shows to members until this screen approves it.
 *
 * Pictures from Wikimedia Commons (DESIGN-learn-web-pictures-fable.md §6.2, §9 slice 2; Marty, 22 Nov 2026, "All six of Fable's
 * picks"): under each, what the node read (`photoCredits`): "📷 maker · licence", "From Wikimedia Commons. Read by this server
 * on {date}.", Commons' note on other rights when it has one, and "Open its page" (the file's page, a new tab). Under one an
 * assistant uploaded: "Uploaded by the assistant. Keep it only if it is your own." Keep, Remove and Approve are unchanged: the
 * app never sends a credit, the node keeps its own with each picture kept. The forms list the page's own sources only.
 */
import { useEffect, useState } from 'react';
import {
    KNOWLEDGE_DECLINE_REASONS, KNOWLEDGE_LIMITS, t, timeAgo, upperCase, type KnowledgeDraftToCheck, type KnowledgeDraftWhole, type KnowledgeFixPart,
    type KnowledgePageWords, type KnowledgePhotoCredit, type KnowledgeRow,
} from '@beanpool/core';
import {
    approveLearnDraft, declineLearnDraft, getLearnDraft, getLearnToCheck, languageNameOf, learnRefusalText, safeSourceUrl, sourceHost, topicEmoji, topicLabel,
} from '../lib/learn';
import { shownLanguage } from '../lib/language';
import { LearnForm } from './LearnForm';
import { LearnRow } from './LearnRow';
import { CHIP, PAGE_BOX, BOX_LABEL } from './market-card-shell';

const MUTED = 'text-nature-600 dark:text-nature-300';
const TOPIC_CHIP = `${CHIP} bg-bp-chip-learn-tint text-bp-chip-learn-ink`;
const BUTTON = 'w-full min-h-[48px] rounded-xl px-4 py-2.5 font-bold disabled:opacity-60 disabled:cursor-not-allowed';
const SECOND = `${BUTTON} border border-nature-300 dark:border-nature-600 bg-white dark:bg-nature-900 text-nature-900 dark:text-white`;
const SMALL = 'self-start min-h-[44px] px-3 rounded-lg text-sm font-bold border border-nature-300 dark:border-nature-600 bg-white dark:bg-nature-900 text-nature-900 dark:text-white';

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

/** A part of a page as the checker reads it beside its other version (slice K5): words as written, a topic and a language by name. */
function partText(part: KnowledgeFixPart, w: Pick<KnowledgePageWords, KnowledgeFixPart>): string {
    if (part === 'topic') return topicLabel(w.topic);
    if (part === 'lang') return w.lang ? languageNameOf(w.lang) : '';
    if (part === 'sources') return w.sources.map((s) => s.label ? `${s.label} (${sourceHost(s.url)})` : sourceHost(s.url)).join('\n');
    return w[part] ?? '';
}
const partLabel = (part: KnowledgeFixPart) => ({
    title: t('Title'), body: t('What to know'), topic: t('Topic'), place: t('Where', undefined, 'To check: the part of a page of Local knowledge that names its place'),
    sources: t('Sources'), lang: t('Language'),
})[part];

/** The site's own name, never translated (a name, not BeanPool's Commons). */
const COMMONS = 'Wikimedia Commons';
/** Commons' note on other rights, by its code: a person, a trademark, or any other it lists. */
const commonsNote = (code: string) => (code === 'personality' ? t('{site} notes: shows a person.', { site: COMMONS })
    : code === 'trademarked' ? t('{site} notes: shows a trademark.', { site: COMMONS }) : t('{site} notes: other rights may apply.', { site: COMMONS }));

/** What the node read from Wikimedia Commons for one picture, under it in To check (§6.2). */
function CommonsCredit({ credit }: { credit: KnowledgePhotoCredit }) {
    const href = safeSourceUrl(credit.url);
    const read = new Date(credit.readAt).toLocaleDateString(shownLanguage(), { day: 'numeric', month: 'short', year: 'numeric' });
    const notes = [...new Set(credit.restrictions.map(commonsNote))];
    return (
        <div data-testid="learn-check-credit" className="flex flex-col gap-0.5 text-sm">
            <p dir="auto" className="m-0 font-bold text-nature-900 dark:text-white break-words">{credit.maker ? `📷 ${credit.maker} · ${credit.licence}` : `📷 ${credit.licence}`}</p>
            <p className={`m-0 text-xs ${MUTED}`}>{t('From {site}. Read by this server on {date}.', { site: COMMONS, date: read })}</p>
            {notes.map((note) => <p key={note} data-testid="learn-check-credit-note" className="m-0 text-xs font-bold text-bp-ink-warning">{note}</p>)}
            {href && (
                <a data-testid="learn-check-credit-page" href={href} target="_blank" rel="noopener noreferrer"
                    className="self-start inline-flex items-center gap-1 min-h-[44px] font-bold text-bp-ink-learn hover:underline">
                    {t('Open its page')}<span aria-hidden="true">↗</span>
                </a>
            )}
        </div>
    );
}

/** A page's tags as the checker reads them: each with its `#`, or "None" where there are none. */
const tagsText = (tags: readonly string[] | undefined) => (tags && tags.length > 0 ? tags.map((tag) => `#${tag}`).join(' ') : t('None'));

/** One changed part, "Now" beside "Suggested", amber when the page changed there since the fix was sent. */
function FixPart({ id, label, moved, now, suggested }: { id: string; label: string; moved: boolean; now: string; suggested: string }) {
    return (
        <section data-testid={`learn-check-part-${id}`} className={PAGE_BOX}>
            <h3 className={BOX_LABEL.muted}>{label}</h3>
            {moved && <p data-testid="learn-check-moved" className="m-0 mb-1 text-sm font-bold text-bp-ink-warning">{t('▲ The page changed here since the fix was sent.')}</p>}
            <p className={`m-0 text-xs font-bold ${MUTED}`}>{t('Now', undefined, 'To check: a part of a page of Local knowledge as it shows now, beside the fix')}</p>
            <p dir="auto" className="m-0 mb-1 text-sm whitespace-pre-wrap break-words">{now}</p>
            <p className={`m-0 text-xs font-bold ${MUTED}`}>{t('Suggested', undefined, 'To check: the same part as the fix would write it')}</p>
            <p dir="auto" className="m-0 text-sm font-bold whitespace-pre-wrap break-words">{suggested}</p>
        </section>
    );
}

/** A fix's changed parts, each as "Now" (the page as it shows) beside "Suggested" (what Approve writes). */
function FixParts({ d }: { d: KnowledgeDraftWhole }) {
    const changed = d.changed ?? [];
    const moved = new Set(d.pageChanged ?? []);
    const tagsChanged = d.freeTagsChanged === true;
    // The page stopped showing (taken down, hidden): nothing to compare, and Approve is refused; "Not this one" answers it.
    if (!d.post) return <p data-testid="learn-check-page-gone" className={`m-0 text-sm ${MUTED}`}>{t("This page of Local knowledge isn't showing any more.")}</p>;
    if (changed.length === 0 && !tagsChanged) return <p data-testid="learn-check-note-alone" className={`m-0 text-sm ${MUTED}`}>{t('Only the note: no words changed.')}</p>;
    const now = d.post;
    return (
        <div data-testid="learn-check-parts" className="flex flex-col gap-2">
            {changed.map((part) => (
                <FixPart key={part} id={part} label={partLabel(part)} moved={moved.has(part)} now={partText(part, now)} suggested={partText(part, d)} />
            ))}
            {tagsChanged && (
                <FixPart id="tags" label={t('Tags')} moved={d.freeTagsPageChanged === true} now={tagsText(now.freeTags)} suggested={tagsText(d.freeTags)} />
            )}
        </div>
    );
}

/** The list of what waits, and under it the pages not checked for a year. */
export function LearnCheckList({ onOpen, onOpenPage }: { onOpen: (id: string) => void; onOpenPage?: (id: string) => void }) {
    const [list, setList] = useState<{ drafts: KnowledgeDraftToCheck[]; total: number; unchecked?: { total: number; rows: KnowledgeRow[] } } | 'failed' | null>(null);
    const [tries, setTries] = useState(0);
    useEffect(() => {
        let live = true;
        getLearnToCheck().then((l) => { if (live) setList(l); }, () => { if (live) setList('failed'); });
        return () => { live = false; };
    }, [tries]);
    if (list === 'failed') return <Failed onAgain={() => setTries((n) => n + 1)} />;
    if (!list) return <p className={MUTED}>{t('Loading...')}</p>;
    const old = list.unchecked && list.unchecked.rows.length > 0 ? list.unchecked : null;
    const year = old && (
        <section data-testid="learn-check-year" className="pt-4">
            <h2 className="m-0 mb-2 text-sm font-extrabold text-nature-800 dark:text-nature-100">{t('Not checked for a year ({n})', { n: old.total })}</h2>
            <div className="flex flex-col gap-2">{old.rows.map((row) => <LearnRow key={row.id} row={row} onOpen={() => onOpenPage?.(row.id)} />)}</div>
        </section>
    );
    if (list.drafts.length === 0) return <><p data-testid="learn-check-empty" className={`py-4 ${MUTED}`}>{t('Nothing to check.')}</p>{year}</>;
    return (
        <>
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
        {year}
        </>
    );
}

/**
 * One suggestion, whole, and its answer. `onAnswered` returns to the list once it is answered (or was already). "Edit first" is
 * the page's to hold (`editing`, `onEditing`), so the page's Back leaves the form for this suggestion, never for the list, and
 * `onEdited` tells it whether anything in the form was changed (Back asks before that is lost).
 */
export function LearnCheckOne({ id, onAnswered, editing, onEditing, onEdited }: {
    id: string; onAnswered: (said: string) => void; editing: boolean; onEditing: (editing: boolean) => void; onEdited?: (edited: boolean) => void;
}) {
    const [draft, setDraft] = useState<KnowledgeDraftWhole | null | 'failed' | undefined>(undefined);
    const [tries, setTries] = useState(0);
    const [ticked, setTicked] = useState(false);
    const [mode, setMode] = useState<'read' | 'no'>('read');
    const [reason, setReason] = useState<string | null>(null);
    const [words, setWords] = useState('');
    const [busy, setBusy] = useState(false);
    const [refusal, setRefusal] = useState<string | null>(null);
    /** The pictures the checker removed, by their place in the draft: Approve and "Edit first" leave them out. */
    const [removed, setRemoved] = useState<number[]>([]);
    useEffect(() => {
        let live = true;
        setDraft(undefined);
        getLearnDraft(id).then((d) => { if (live) setDraft(d); }, () => { if (live) setDraft('failed'); });
        return () => { live = false; };
    }, [id, tries]);

    if (draft === 'failed') return <Failed onAgain={() => setTries((n) => n + 1)} />;
    if (draft === undefined) return <p className={MUTED}>{t('Loading...')}</p>;
    if (draft === null) {
        return <p data-testid="learn-check-gone" className={`py-4 ${MUTED}`}>{t('This one was already answered.')}</p>;
    }
    const d = draft;
    // An assistant's draft (K6): its name may be empty, so it is told by the field being there, not by what it says.
    const byAssistant = d.assistant !== null;
    const fix = d.kind === 'fix';
    const mayApprove = !d.needsSourcesTicked || ticked;
    // Only a picture shown here can be kept: Approve publishes what the checker saw and kept, nothing else.
    const shownPhoto = (src: string) => src.startsWith('data:image/');
    const keptPhotos = d.photos.filter((src, i) => shownPhoto(src) && !removed.includes(i));
    const toggle = (i: number) => setRemoved((was) => (was.includes(i) ? was.filter((x) => x !== i) : [...was, i]));
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

    if (editing) {
        return (
            <LearnForm use="approve" keepPhotosOnly={!byAssistant}
                initial={{ title: d.title, body: d.body, topic: d.topic, place: d.place ?? '', sources: d.sources, photos: keptPhotos, freeTags: d.freeTags ?? [] }}
                onEdited={onEdited} approvesFix={fix}
                onSend={async (edits) => {
                    await approveLearnDraft(d.id, { edits, lang: d.lang, checkedSources: d.needsSourcesTicked, fix });
                    onAnswered(fix ? t('Approved. The page shows the fix now.') : t('Approved. It is in Learn.'));
                }} />
        );
    }

    return (
        <article data-testid="learn-check-one" className="flex flex-col gap-3 pt-2 pb-4">
            <div className="flex flex-wrap items-center gap-1">
                <span className={TOPIC_CHIP}>{upperCase(topicLabel(d.topic))}</span>
                <span className={TOPIC_CHIP}>{upperCase(kindWord(d.kind))}</span>
                {byAssistant && <span data-testid="learn-check-gathered" className={TOPIC_CHIP}>{upperCase(t('Gathered with the assistant'))}</span>}
            </div>
            <h2 dir="auto" className="m-0 text-xl font-extrabold leading-snug text-nature-950 dark:text-white break-words">{d.title}</h2>
            <p className={`m-0 text-sm ${MUTED} break-words flex flex-wrap gap-x-2`}><span>{fromWords(d)}</span><span>{waited(d.createdAt)}</span></p>
            {d.note && (
                <section className={PAGE_BOX}>
                    <h3 className={BOX_LABEL.muted}>{t('What changed')}</h3>
                    <p dir="auto" className="m-0 text-sm break-words">{d.note}</p>
                </section>
            )}
            {fix && <FixParts d={d} />}
            <div dir="auto" data-testid="learn-check-body" className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-nature-900 dark:text-nature-50">{d.body}</div>
            {d.place && <p dir="auto" className="m-0 text-sm font-bold text-nature-800 dark:text-nature-100 break-words">{t('Where: {place}', { place: d.place })}</p>}
            {(d.freeTags?.length ?? 0) > 0 && (
                <section data-testid="learn-check-tags" className={PAGE_BOX}>
                    <h3 className={BOX_LABEL.muted}>{t('Tags')}</h3>
                    <p dir="auto" className="m-0 text-sm break-words">{tagsText(d.freeTags)}</p>
                </section>
            )}
            {d.photos.length > 0 && (
                <section data-testid="learn-check-photos" className="flex flex-col gap-2">
                    <p className={`m-0 text-xs ${MUTED}`}>{t('Approve adds only the photos you keep. Keep one if it is the writer’s own, or if it shows who made it and its licence.')}</p>
                    {d.photos.map((src, i) => {
                        if (!shownPhoto(src)) return null;
                        const out = removed.includes(i);
                        const credit = d.photoCredits?.[i] ?? null;
                        return (
                            <figure key={i} data-testid="learn-check-photo" data-kept={out ? 'false' : 'true'} className="m-0 flex flex-col gap-1">
                                <img src={src} alt={t('Photo {n}', { n: i + 1 })} className={`w-full aspect-[4/3] object-cover rounded-xl ${out ? 'opacity-40' : ''}`} />
                                {credit && <CommonsCredit credit={credit} />}
                                {!credit && byAssistant && <p data-testid="learn-check-uploaded" className={`m-0 text-xs ${MUTED}`}>{t('Uploaded by the assistant. Keep it only if it is your own.')}</p>}
                                {out && <p className={`m-0 text-xs ${MUTED}`}>{t('Left out: Approve won’t add it.')}</p>}
                                <button type="button" data-testid="learn-check-photo-toggle" disabled={busy} onClick={() => toggle(i)} className={SMALL}>
                                    {out ? t('Keep this photo') : t('Remove photo')}
                                </button>
                            </figure>
                        );
                    })}
                </section>
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
                        onClick={() => reason && void act(() => declineLearnDraft(d.id, reason, words),
                            // An assistant's draft has no writer to tell: its owner or admin hears how it ended through their assistant.
                            byAssistant ? t("Answered. It won't be added to Learn.") : t('Answered. The writer is told.'))}
                        className={`${BUTTON} bg-bp-cta-fill hover:bg-bp-cta-hover text-bp-cta-on`}>{t('Send')}</button>
                    <button type="button" onClick={() => setMode('read')} className={SECOND}>{t('Back')}</button>
                </fieldset>
            ) : (
                <div className="flex flex-col gap-2">
                    <p className={`m-0 text-xs ${MUTED}`}>{fix ? t('Approving changes the page now.') : t('Approving adds it to Learn and announces it in the Pulse.')}</p>
                    {refusal && <p role="alert" className="m-0 text-sm font-bold text-red-700 dark:text-red-300">{refusal}</p>}
                    <button type="button" data-testid="learn-check-approve" disabled={!mayApprove || busy}
                        onClick={() => void act(() => approveLearnDraft(d.id, {
                            checkedSources: d.needsSourcesTicked,
                            // The kept pictures, sent back so only those are published (a fix brings none).
                            ...(!fix && d.photos.length > 0 ? { photos: keptPhotos } : {}),
                        }), fix ? t('Approved. The page shows the fix now.') : t('Approved. It is in Learn.'))}
                        className={`${BUTTON} bg-bp-cta-fill hover:bg-bp-cta-hover text-bp-cta-on`}>{t('Approve')}</button>
                    <button type="button" data-testid="learn-check-edit" disabled={!mayApprove || busy} onClick={() => onEditing(true)} className={SECOND}>{t('Edit first')}</button>
                    <button type="button" data-testid="learn-check-not" disabled={busy} onClick={() => setMode('no')} className={SECOND}>{t('Not this one')}</button>
                </div>
            )}
        </article>
    );
}
