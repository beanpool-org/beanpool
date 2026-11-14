/**
 * The form of Local knowledge (slice K4; DESIGN-local-knowledge-fable.md §3.3 as amended §3.3): one screen in Learn, reached by
 * "＋ Suggest knowledge", the New Post panel's fifth button and Home's "Add the first thing…". The phone's is the same screen
 * (apps/native app/learn/new.tsx), the same words in the same order.
 *
 * Three uses, one form: a member's suggestion ("Send to the admins": it waits for an owner or admin), an owner's or admin's own
 * page ("Publish": it goes into Learn at once), and an owner's or admin's "Edit first" on a member's suggestion ("Approve").
 * The node checks everything again; this only says the first thing missing before it sends (lib/learn.ts learnFormRefusal).
 * Photos are optional and the member's own (at most three, the browser's own picker, asked for nothing until 📷 is tapped).
 */
import { useState } from 'react';
import { KNOWLEDGE_LIMITS, KNOWLEDGE_TOPICS, formatCount, t, type KnowledgeSource } from '@beanpool/core';
import { learnFormRefusal, learnRefusalText, topicLabel, type LearnInput } from '../lib/learn';
import { PostPhotoPicker } from './PostPhotoPicker';

export type LearnFormUse = 'suggest' | 'publish' | 'approve';

const LABEL = 'block mb-1 text-xs font-bold uppercase tracking-wider text-nature-600 dark:text-nature-300';
const FIELD = 'w-full min-h-[44px] py-2 px-3 rounded-xl border border-nature-200 dark:border-nature-600 bg-white dark:bg-nature-900 text-nature-900 dark:text-white text-[15px] focus:outline-none focus:ring-2 focus:ring-bp-ink-learn';
const MUTED = 'text-nature-600 dark:text-nature-300';
/** A link's box shows how an address starts: the same in every language. */
const URL_HINT = 'https://';

export function LearnForm({ use, initial, onSend, keepPhotosOnly = false }: {
    use: LearnFormUse;
    /** "Edit first": the suggestion as it was sent. */
    initial?: LearnInput;
    /** "Edit first" on a member's suggestion: their own photos may be kept or taken off, never added to (the node refuses). */
    keepPhotosOnly?: boolean;
    /** Sends what was typed; a refusal it throws is shown under the button. */
    onSend: (input: LearnInput) => Promise<void>;
}) {
    const [title, setTitle] = useState(initial?.title ?? '');
    const [body, setBody] = useState(initial?.body ?? '');
    const [topic, setTopic] = useState(initial?.topic ?? '');
    const [place, setPlace] = useState(initial?.place ?? '');
    const [sources, setSources] = useState<KnowledgeSource[]>(initial?.sources?.length ? initial.sources : []);
    const [photos, setPhotos] = useState<string[]>(initial?.photos ?? []);
    const [refusal, setRefusal] = useState<string | null>(null);
    const [sending, setSending] = useState(false);

    const setSource = (i: number, part: Partial<KnowledgeSource>) => setSources((list) => list.map((s, j) => (j === i ? { ...s, ...part } : s)));
    const send = async () => {
        if (sending) return;
        const input: LearnInput = { title, body, topic, place, sources, photos };
        const said = learnFormRefusal(input);
        setRefusal(said);
        if (said) return;
        setSending(true);
        try {
            await onSend(input);
        } catch (e) {
            setRefusal(learnRefusalText(e));
        } finally {
            setSending(false);
        }
    };

    const button = use === 'suggest' ? t('Send to the admins') : use === 'publish' ? t('Publish') : t('Approve');
    return (
        <form data-testid="learn-form" className="flex flex-col gap-4 pt-2 pb-4" onSubmit={(e) => { e.preventDefault(); void send(); }} noValidate>
            {use !== 'approve' && (
                <p className="m-0 rounded-xl p-3 text-sm bg-bp-chip-learn-tint text-bp-chip-learn-ink">
                    {t('Share something worth knowing about this place: how something works, where to go, who to call. Not about private people. In your own words.')}
                </p>
            )}
            <div>
                <label htmlFor="learn-form-title" className={LABEL}>{t('Title *')}</label>
                <input id="learn-form-title" data-testid="learn-form-title" value={title} maxLength={KNOWLEDGE_LIMITS.title} onChange={(e) => setTitle(e.target.value)}
                    placeholder={t('e.g. How recycling works at the tip')} dir="auto" className={FIELD} />
            </div>
            <div>
                <label htmlFor="learn-form-body" className={LABEL}>{t('What to know *')}</label>
                <textarea id="learn-form-body" data-testid="learn-form-body" value={body} maxLength={KNOWLEDGE_LIMITS.body} onChange={(e) => setBody(e.target.value)}
                    placeholder={t('Put the answer first. Then the details.')} rows={6} dir="auto" className={`${FIELD} resize-y`} />
                <p className={`m-0 mt-1 text-end text-xs ${MUTED}`}>{formatCount(body.length)}/{formatCount(KNOWLEDGE_LIMITS.body)}</p>
            </div>
            <fieldset className="m-0 p-0 border-0 min-w-0">
                <legend className={LABEL}>{t('Topic *')}</legend>
                <div data-testid="learn-form-topics" className="flex flex-wrap gap-2">
                    {KNOWLEDGE_TOPICS.map((tp) => (
                        <button key={tp.id} type="button" aria-pressed={topic === tp.id} onClick={() => setTopic(tp.id)}
                            className={`min-h-[44px] px-3 rounded-full inline-flex items-center text-sm cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-learn ${
                                topic === tp.id
                                    ? 'bg-bp-chip-learn-tint text-bp-chip-learn-ink border-2 border-bp-ink-learn font-black'
                                    : 'bg-white dark:bg-nature-900 text-nature-700 dark:text-nature-200 border border-nature-300 dark:border-nature-600 font-bold'
                            }`}>
                            <span aria-hidden="true" className="me-1.5">{tp.emoji}</span><span>{topicLabel(tp.id)}</span>
                        </button>
                    ))}
                </div>
            </fieldset>
            <div>
                <label htmlFor="learn-form-place" className={LABEL}>{t('Where (optional)')}</label>
                <input id="learn-form-place" data-testid="learn-form-place" value={place} maxLength={KNOWLEDGE_LIMITS.place} onChange={(e) => setPlace(e.target.value)}
                    placeholder={t('e.g. The tip on Manse Road')} dir="auto" className={FIELD} />
            </div>
            <fieldset className="m-0 p-0 border-0 min-w-0">
                <legend className={LABEL}>{t('Where can people check this? (optional)')}</legend>
                <div className="flex flex-col gap-3">
                    {sources.map((s, i) => (
                        <div key={i} data-testid="learn-form-source" className="flex flex-col gap-2 rounded-xl border border-nature-200 dark:border-nature-700 p-2">
                            <input type="url" inputMode="url" value={s.url} maxLength={KNOWLEDGE_LIMITS.sourceUrl} onChange={(e) => setSource(i, { url: e.target.value })}
                                placeholder={URL_HINT} aria-label={t('Link {n}', { n: i + 1 })} className={FIELD} />
                            <input value={s.label} maxLength={KNOWLEDGE_LIMITS.sourceLabel} onChange={(e) => setSource(i, { label: e.target.value })}
                                placeholder={t('What is this page? (optional)')} aria-label={t('What is this page? (optional)')} dir="auto" className={FIELD} />
                            <button type="button" onClick={() => setSources((list) => list.filter((_, j) => j !== i))}
                                className={`self-start min-h-[44px] px-1 bg-transparent border-0 cursor-pointer text-sm font-bold ${MUTED} hover:underline`}>
                                {t('Remove link')}
                            </button>
                        </div>
                    ))}
                    {sources.length < KNOWLEDGE_LIMITS.sources && (
                        <button type="button" data-testid="learn-form-add-link" onClick={() => setSources((list) => [...list, { url: '', label: '' }])}
                            className="self-start min-h-[44px] px-1 bg-transparent border-0 cursor-pointer font-bold text-bp-ink-learn hover:underline">
                            {t('＋ Add a link')}
                        </button>
                    )}
                </div>
            </fieldset>
            <div>
                <PostPhotoPicker photos={photos} onChange={setPhotos} max={keepPhotosOnly ? photos.length : KNOWLEDGE_LIMITS.photos} label={t('Photo (optional)')} />
                <p className={`m-0 mt-1 text-xs ${MUTED}`}>{t('Your own photo. Without one, a picture for the topic is shown.')}</p>
            </div>
            {refusal && <p role="alert" data-testid="learn-form-refusal" className="m-0 text-sm font-bold text-red-700 dark:text-red-300">{refusal}</p>}
            <button type="submit" data-testid="learn-form-send" disabled={sending} aria-busy={sending}
                className="w-full min-h-[48px] rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover px-4 py-2.5 font-bold text-bp-cta-on disabled:opacity-60 disabled:cursor-wait">
                {sending ? t('Sending...') : button}
            </button>
            <p className={`m-0 text-xs ${MUTED}`}>
                {use === 'suggest' ? t('An owner or admin checks it before anyone sees it.')
                    : use === 'publish' ? t('It goes into Learn, and the Pulse announces it.')
                    : t('Approving adds it to Learn and announces it in the Pulse.')}
            </p>
        </form>
    );
}
