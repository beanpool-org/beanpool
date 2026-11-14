/**
 * My suggestions (slice K4; DESIGN-local-knowledge-fable.md §3.4 as amended): the member's own suggestions of Local knowledge,
 * reached from Learn's "1 of yours is waiting for an admin ›" and from the answer's notice. The phone's is the same screen
 * (apps/native app/learn/mine.tsx). Waiting ones first, each with "Take it back" (asked once more before it goes); then the
 * answers of the last 30 days: "Added" (its title opens the page) or "Not added: {reason}" with the owner's or admin's own
 * words. Never who answered.
 */
import { useEffect, useState } from 'react';
import { KNOWLEDGE_DECLINE_REASONS, formatDate, t, type KnowledgeDraftMine } from '@beanpool/core';
import { getMyLearnDrafts, learnRefusalText, topicEmoji, withdrawLearnDraft } from '../lib/learn';

const MUTED = 'text-nature-600 dark:text-nature-300';
const ROW = 'rounded-[14px] border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-900 p-3 flex flex-col gap-1';
const LINK = 'min-h-[44px] self-start inline-flex items-center px-1 bg-transparent border-0 cursor-pointer font-bold text-bp-ink-learn hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-learn rounded';

function kindChip(d: KnowledgeDraftMine): string {
    return d.kind === 'fix' ? t('Fix') : t('New', undefined, 'a suggestion of a new page of Local knowledge, not a fix');
}

export function LearnMine({ onOpenPage }: { onOpenPage: (id: string) => void }) {
    const [mine, setMine] = useState<{ waiting: KnowledgeDraftMine[]; answered: KnowledgeDraftMine[] } | 'failed' | null>(null);
    const [tries, setTries] = useState(0);
    const [asking, setAsking] = useState<string | null>(null);
    const [refusal, setRefusal] = useState<string | null>(null);
    useEffect(() => {
        let live = true;
        getMyLearnDrafts().then((m) => { if (live) setMine(m); }, () => { if (live) setMine('failed'); });
        return () => { live = false; };
    }, [tries]);

    const takeBack = async (id: string) => {
        setRefusal(null);
        try {
            await withdrawLearnDraft(id);
            setAsking(null);
            setMine((m) => (m && m !== 'failed' ? { ...m, waiting: m.waiting.filter((d) => d.id !== id) } : m));
        } catch (e) {
            setRefusal(learnRefusalText(e));
        }
    };

    if (mine === 'failed') {
        return (
            <div role="alert" className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 p-3 text-sm text-red-700 dark:text-red-300">
                <p className="m-0 mb-2">{t("Couldn't load Learn. Check your connection and try again.")}</p>
                <button type="button" onClick={() => setTries((n) => n + 1)} className="min-h-[44px] px-3 rounded-lg border border-red-300 dark:border-red-700 font-bold">{t('Try again')}</button>
            </div>
        );
    }
    if (!mine) return <p className={MUTED}>{t('Loading...')}</p>;
    if (mine.waiting.length === 0 && mine.answered.length === 0) return <p data-testid="learn-mine-empty" className={`py-4 ${MUTED}`}>{t('Nothing waiting.')}</p>;
    return (
        <div data-testid="learn-mine" className="flex flex-col gap-2 pt-2">
            {refusal && <p role="alert" className="m-0 text-sm font-bold text-red-700 dark:text-red-300">{refusal}</p>}
            {mine.waiting.map((d) => (
                <div key={d.id} data-testid="learn-mine-waiting" className={ROW}>
                    <p dir="auto" className="m-0 font-bold text-nature-900 dark:text-white break-words"><span aria-hidden="true">{topicEmoji(d.topic)} </span>{d.title}</p>
                    <p className={`m-0 text-sm ${MUTED} flex flex-wrap gap-x-2`}><span className="font-bold">{kindChip(d)}</span><span>{t('Waiting since {date}', { date: formatDate(new Date(d.createdAt), 'day-month') })}</span></p>
                    {asking === d.id ? (
                        <div className="flex flex-col gap-1">
                            <p className="m-0 text-sm font-bold text-nature-900 dark:text-white">{t("Take this back? The admins won't see it.")}</p>
                            <div className="flex flex-wrap gap-2">
                                <button type="button" data-testid="learn-mine-confirm" onClick={() => void takeBack(d.id)} className={LINK}>{t('Take it back')}</button>
                                <button type="button" onClick={() => setAsking(null)} className={LINK}>{t('Keep it')}</button>
                            </div>
                        </div>
                    ) : (
                        <button type="button" data-testid="learn-mine-take-back" onClick={() => setAsking(d.id)} className={LINK}>{t('Take it back')}</button>
                    )}
                </div>
            ))}
            {mine.answered.map((d) => {
                const reason = KNOWLEDGE_DECLINE_REASONS.find((r) => r.id === d.reason) ?? KNOWLEDGE_DECLINE_REASONS[KNOWLEDGE_DECLINE_REASONS.length - 1];
                return (
                    <div key={d.id} data-testid="learn-mine-answered" className={ROW}>
                        {d.state === 'approved' && d.postId ? (
                            <button type="button" onClick={() => onOpenPage(d.postId!)} dir="auto" className={`${LINK} text-start break-words`}>{d.title}</button>
                        ) : <p dir="auto" className="m-0 font-bold text-nature-900 dark:text-white break-words">{d.title}</p>}
                        <p className={`m-0 text-sm ${MUTED} flex flex-wrap gap-x-2`}>
                            <span className="font-bold">{kindChip(d)}</span><span>{d.state === 'approved' ? t('Added') : t('Not added: {reason}', { reason: t(reason.label) })}</span>
                        </p>
                        {d.state === 'declined' && d.reasonWords && <p dir="auto" className="m-0 text-sm text-nature-800 dark:text-nature-100 break-words">{d.reasonWords}</p>}
                    </div>
                );
            })}
        </div>
    );
}
