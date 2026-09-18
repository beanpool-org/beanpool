/**
 * "Suggest a change to BeanPool" — goes to the BeanPool project (beanpool.org), never to this
 * community's node. The community field starts empty: the member decides whether to say where they are.
 * On failure the text stays exactly as typed. Mirrors apps/native/app/suggest-change.tsx.
 */

import { useState, type FormEvent } from 'react';
import {
    FEEDBACK_KINDS, FEEDBACK_NOTICE, FEEDBACK_THANKS, FEEDBACK_TEXT_MAX, FEEDBACK_COMMUNITY_MAX,
    feedbackCharCount, feedbackTextProblem, submitFeedback, type FeedbackKind, type FeedbackResult,
    type FeedbackInput,
} from '@beanpool/core';

interface Props {
    appVersion: string;
    onDone: () => void;
    /** Injected in tests; defaults to the real client. */
    submit?: (input: FeedbackInput) => Promise<FeedbackResult>;
}

const browserLang = (): string | null => {
    try { return navigator.language || null; } catch { return null; }
};

export function SuggestChangeForm({ appVersion, onDone, submit = submitFeedback }: Props) {
    const [kind, setKind] = useState<FeedbackKind>('idea');
    const [text, setText] = useState('');
    const [community, setCommunity] = useState(''); // EMPTY by design — never prefilled from the node
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sent, setSent] = useState(false);

    const count = feedbackCharCount(text);
    const over = count > FEEDBACK_TEXT_MAX;

    const handleSend = async (e: FormEvent) => {
        e.preventDefault();
        if (sending) return;
        const problem = feedbackTextProblem(text);
        if (problem) { setError(problem); return; }
        setSending(true);
        setError(null);
        const result = await submit({
            text, kind, source: 'web', appVersion, platform: 'web', lang: browserLang(), community,
        });
        setSending(false);
        if (result.ok) setSent(true);
        else setError(result.error);
    };

    if (sent) {
        return (
            <div className="bg-white dark:bg-nature-900 rounded-2xl p-6 shadow-soft border border-nature-200 dark:border-nature-800 text-center">
                <p className="text-3xl mb-2" aria-hidden="true">🌱</p>
                <p className="text-[15px] font-semibold text-nature-900 dark:text-white mb-5" role="status">{FEEDBACK_THANKS}</p>
                <button
                    type="button"
                    onClick={onDone}
                    className="w-full min-h-[48px] py-3 rounded-xl font-semibold bg-oat-100 dark:bg-nature-800 text-nature-700 dark:text-nature-300 border-none cursor-pointer hover:bg-oat-200 transition-colors text-sm"
                >
                    ← Back to Settings
                </button>
            </div>
        );
    }

    return (
        <form onSubmit={handleSend} className="bg-white dark:bg-nature-900 rounded-2xl p-6 shadow-soft border border-nature-200 dark:border-nature-800">
            <h3 className="text-lg font-bold text-nature-950 dark:text-white mb-2">💬 Suggest a change to BeanPool</h3>
            <p className="text-sm text-nature-700 dark:text-nature-300 mb-5 leading-relaxed bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded-xl p-3">
                {FEEDBACK_NOTICE}
            </p>

            <div className="text-xs font-bold uppercase tracking-wider text-nature-500 dark:text-nature-400 mb-2" id="suggest-kind-label">What kind?</div>
            <div className="flex flex-wrap gap-2 mb-5" role="radiogroup" aria-labelledby="suggest-kind-label">
                {FEEDBACK_KINDS.map((k) => {
                    const on = kind === k.id;
                    return (
                        <button
                            key={k.id}
                            type="button"
                            role="radio"
                            aria-checked={on}
                            onClick={() => setKind(k.id)}
                            className={`min-h-[48px] px-5 rounded-full text-sm font-semibold border cursor-pointer transition-colors ${on
                                ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-500 text-emerald-800 dark:text-emerald-300'
                                : 'bg-white dark:bg-nature-800 border-nature-300 dark:border-nature-700 text-nature-700 dark:text-nature-300'}`}
                        >
                            {k.label}
                        </button>
                    );
                })}
            </div>

            <label htmlFor="suggest-text" className="block text-xs font-bold uppercase tracking-wider text-nature-500 dark:text-nature-400 mb-2">Your suggestion</label>
            <textarea
                id="suggest-text"
                value={text}
                onChange={(e) => { setText(e.target.value); if (error) setError(null); }}
                rows={6}
                placeholder="What would make BeanPool better for your community? Any language is fine."
                className="w-full p-3 rounded-xl border border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-800 text-nature-900 dark:text-white text-base resize-y"
            />
            <div className={`text-xs text-right mt-1 mb-5 ${over ? 'text-red-600 font-bold' : 'text-nature-500 dark:text-nature-400'}`}>
                {count} / {FEEDBACK_TEXT_MAX}
            </div>

            <label htmlFor="suggest-community" className="block text-xs font-bold uppercase tracking-wider text-nature-500 dark:text-nature-400 mb-2">Your community (optional)</label>
            <input
                id="suggest-community"
                type="text"
                value={community}
                onChange={(e) => setCommunity(e.target.value)}
                maxLength={FEEDBACK_COMMUNITY_MAX}
                autoComplete="off"
                placeholder="Leave blank if you'd rather not say"
                className="w-full min-h-[48px] p-3 rounded-xl border border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-800 text-nature-900 dark:text-white text-base"
            />
            <p className="text-xs text-nature-500 dark:text-nature-400 mt-1 mb-5">Helps us see how many places ask for the same thing.</p>

            {error && (
                <div role="alert" className="mb-4 p-3 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 text-sm font-semibold text-red-700 dark:text-red-300">
                    {error}
                </div>
            )}

            <button
                type="submit"
                disabled={sending || over}
                className="w-full min-h-[48px] py-3 rounded-xl font-bold bg-emerald-600 text-white border-none cursor-pointer hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm mb-3"
            >
                {sending ? 'Sending…' : 'Send'}
            </button>
            <button
                type="button"
                onClick={onDone}
                className="w-full min-h-[48px] py-3 rounded-xl font-semibold bg-oat-100 dark:bg-nature-800 text-nature-700 dark:text-nature-300 border-none cursor-pointer hover:bg-oat-200 transition-colors text-sm"
            >
                ← Back to Settings
            </button>
        </form>
    );
}
