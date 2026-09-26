/**
 * "Suggest a change to BeanPool" for node operators (source=settings-app).
 *
 * Goes to the BeanPool project at beanpool.org — not to this node, and not to its members. Operators of
 * self-hosted nodes we never talk to reach the project the same way. The community field starts empty:
 * the operator decides whether to say which node they run. On failure the text stays as typed.
 * Mirrors apps/pwa/src/components/SuggestChangeForm.tsx in the Settings app's own styling.
 */

import React, { useState } from 'react';
import {
    FEEDBACK_KINDS, FEEDBACK_NOTICE, FEEDBACK_THANKS, FEEDBACK_TEXT_MAX, FEEDBACK_COMMUNITY_MAX,
    feedbackCharCount, feedbackTextProblem, submitFeedback, type FeedbackKind, type FeedbackResult,
    type FeedbackInput,
} from '@beanpool/core';

interface Props {
    appVersion: string;
    /** Injected in tests; defaults to the real client. */
    submit?: (input: FeedbackInput) => Promise<FeedbackResult>;
}

const browserLang = (): string | null => {
    try { return navigator.language || null; } catch { return null; }
};

export function SuggestChangePanel({ appVersion, submit = submitFeedback }: Props) {
    const [open, setOpen] = useState(false);
    const [kind, setKind] = useState<FeedbackKind>('idea');
    const [text, setText] = useState('');
    const [community, setCommunity] = useState(''); // EMPTY by design — never prefilled from the node
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sent, setSent] = useState(false);

    const count = feedbackCharCount(text);
    const over = count > FEEDBACK_TEXT_MAX;

    const handleSend = async (e: React.FormEvent) => {
        e.preventDefault();
        if (sending) return;
        const problem = feedbackTextProblem(text);
        if (problem) { setError(problem); return; }
        setSending(true);
        setError(null);
        const result = await submit({
            text, kind, source: 'settings-app', appVersion, platform: 'web', lang: browserLang(), community,
        });
        setSending(false);
        if (result.ok) {
            setSent(true);
            setText('');
            setCommunity('');
        } else {
            setError(result.error);
        }
    };

    return (
        <div className="mt-6 bg-nature-900 border border-nature-800 rounded-2xl p-5">
            {!open ? (
                <button
                    type="button"
                    onClick={() => { setOpen(true); setSent(false); }}
                    className="w-full min-h-[48px] flex items-center gap-3 text-left"
                >
                    <span className="text-2xl" aria-hidden="true">💬</span>
                    <span className="flex-1">
                        <span className="block text-sm font-bold text-white">Suggest a change to BeanPool</span>
                        <span className="block text-xs text-nature-400 mt-0.5">Ideas and problems go to the BeanPool project team</span>
                    </span>
                    <span className="text-nature-400" aria-hidden="true">→</span>
                </button>
            ) : sent ? (
                <div className="text-center">
                    <p className="text-sm font-semibold text-white mb-4" role="status">{FEEDBACK_THANKS}</p>
                    <button
                        type="button"
                        onClick={() => { setOpen(false); setSent(false); }}
                        className="min-h-[48px] px-5 rounded-lg bg-nature-800 hover:bg-nature-700 text-sm font-bold text-nature-200 border border-nature-700"
                    >
                        Close
                    </button>
                </div>
            ) : (
                <form onSubmit={handleSend}>
                    <h3 className="text-base font-bold text-white mb-2">💬 Suggest a change to BeanPool</h3>
                    <p className="text-sm text-nature-300 mb-4 leading-relaxed bg-nature-800/60 border border-nature-700 rounded-lg p-3">
                        {FEEDBACK_NOTICE}
                    </p>

                    <div className="text-xs font-bold uppercase tracking-wider text-nature-400 mb-2" id="op-suggest-kind-label">What kind?</div>
                    <div className="flex flex-wrap gap-2 mb-4" role="radiogroup" aria-labelledby="op-suggest-kind-label">
                        {FEEDBACK_KINDS.map((k) => {
                            const on = kind === k.id;
                            return (
                                <button
                                    key={k.id}
                                    type="button"
                                    role="radio"
                                    aria-checked={on}
                                    onClick={() => setKind(k.id)}
                                    className={`min-h-[48px] px-5 rounded-full text-sm font-semibold border transition-colors ${on
                                        ? 'bg-terra-900/40 border-terra-500 text-terra-200'
                                        : 'bg-nature-800 border-nature-700 text-nature-300 hover:bg-nature-700'}`}
                                >
                                    {k.label}
                                </button>
                            );
                        })}
                    </div>

                    <label htmlFor="op-suggest-text" className="block text-xs font-bold uppercase tracking-wider text-nature-400 mb-2">Your suggestion</label>
                    <textarea
                        id="op-suggest-text"
                        value={text}
                        onChange={(e) => { setText(e.target.value); if (error) setError(null); }}
                        rows={6}
                        placeholder="What would make running a BeanPool node better? Any language is fine."
                        className="w-full p-3 rounded-lg border border-nature-700 bg-nature-950 text-white text-sm resize-y"
                    />
                    <div className={`text-xs text-right mt-1 mb-4 ${over ? 'text-red-400 font-bold' : 'text-nature-500'}`}>
                        {count} / {FEEDBACK_TEXT_MAX}
                    </div>

                    <label htmlFor="op-suggest-community" className="block text-xs font-bold uppercase tracking-wider text-nature-400 mb-2">Your community (optional)</label>
                    <input
                        id="op-suggest-community"
                        type="text"
                        value={community}
                        onChange={(e) => setCommunity(e.target.value)}
                        maxLength={FEEDBACK_COMMUNITY_MAX}
                        autoComplete="off"
                        placeholder="Leave blank if you'd rather not say"
                        className="w-full min-h-[48px] p-3 rounded-lg border border-nature-700 bg-nature-950 text-white text-sm mb-4"
                    />

                    {error && (
                        <div role="alert" className="mb-4 p-3 rounded-lg bg-red-950/40 border border-red-800 text-sm font-semibold text-red-300">
                            {error}
                        </div>
                    )}

                    <div className="flex flex-wrap gap-2">
                        <button
                            type="submit"
                            disabled={sending || over}
                            className="flex-1 min-h-[48px] px-5 rounded-lg bg-terra-600 hover:bg-terra-500 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-bold text-white flex items-center justify-center gap-2"
                        >
                            {sending ? (
                                <>
                                    <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" aria-hidden="true" />
                                    <span>Sending…</span>
                                </>
                            ) : (
                                'Send'
                            )}
                        </button>
                        <button
                            type="button"
                            onClick={() => setOpen(false)}
                            className="min-h-[48px] px-5 rounded-lg bg-nature-800 hover:bg-nature-700 text-sm font-bold text-nature-200 border border-nature-700"
                        >
                            Cancel
                        </button>
                    </div>
                </form>
            )}
        </div>
    );
}
