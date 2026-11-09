import React, { useState } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { nodeCredential } from '../../lib/profiles';
import { getTfaSessionToken } from '../../lib/node-client';
import { t } from '../../lib/fresh-proof';
import { ADVICE_MAX, adviseOwners, type Shape } from '../../lib/community-shape';

/**
 * "Advise the owners" under a Core row, for an admin (DESIGN-core-settings-fable.md §5, slice C4): up to ADVICE_MAX characters
 * about one setting, sent to every owner as an alert and kept as a line in the Changes log. It changes nothing, so it asks
 * for no proof. The words are the admin's own and are drawn as text only (React escapes them; nothing here is HTML).
 */
export function AdviseTheOwners({
    setting,
    settingName,
    activeNode,
    onSent,
}: {
    /** The shape's name for the Core setting (`beans`, `join`, …). */
    setting: string;
    /** Its name as the page shows it ("Beans"). */
    settingName: string;
    activeNode: NodeProfile;
    /** The shape the server answered, its log with the new line at the head. */
    onSent: (shape: Shape) => void;
}) {
    const [open, setOpen] = useState(false);
    const [text, setText] = useState('');
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const close = () => {
        setOpen(false);
        setText('');
        setError(null);
    };

    if (!open) {
        return (
            <button
                type="button"
                data-testid={`shape-advise-${setting}`}
                aria-expanded={false}
                onClick={() => setOpen(true)}
                className="min-h-[44px] w-full sm:w-auto px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 transition-all"
            >
                {t('Advise the owners')}
            </button>
        );
    }

    const send = async () => {
        if (sending || !text.trim()) return;
        setSending(true);
        setError(null);
        try {
            const res = await adviseOwners(activeNode.url, nodeCredential(activeNode), setting, text, getTfaSessionToken(activeNode.id));
            onSent(res.shape);
            close();
        } catch (err: unknown) {
            setError(err instanceof Error && err.message ? err.message : t('Could not send your advice.'));
        } finally {
            setSending(false);
        }
    };

    const inputId = `shape-advise-text-${setting}`;
    return (
        <div data-testid={`shape-advise-form-${setting}`} className="space-y-2 pt-1">
            <label htmlFor={inputId} className="block text-xs font-bold text-white break-words">
                {t('Your advice about {setting}').replace('{setting}', settingName)}
            </label>
            <p className="text-[11px] text-nature-400 m-0 leading-relaxed">
                {t('Every owner is told you advised, and reads your words here, under Changes. It changes nothing.')}
            </p>
            <textarea
                id={inputId}
                data-testid={inputId}
                value={text}
                maxLength={ADVICE_MAX}
                rows={3}
                onChange={(e) => setText(e.target.value)}
                className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-terra-500 placeholder:text-nature-500 break-words"
            />
            <p data-testid={`shape-advise-count-${setting}`} className="text-[11px] text-nature-400 m-0 text-right">
                {t('{n} of {max}').replace('{n}', String(text.length)).replace('{max}', String(ADVICE_MAX))}
            </p>
            {error && (
                <div role="alert" className="p-2.5 rounded-xl bg-bp-chip-danger-tint text-bp-chip-danger-ink text-xs font-medium break-words">
                    {error}
                </div>
            )}
            <div className="flex items-center gap-2 pt-1">
                <button
                    type="button"
                    data-testid={`shape-advise-send-${setting}`}
                    disabled={sending || !text.trim()}
                    onClick={send}
                    className="py-2 px-4 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-bold text-bp-cta-on transition-all disabled:opacity-50 min-h-[40px]"
                >
                    {sending ? t('Sending...') : t('Send')}
                </button>
                <button
                    type="button"
                    disabled={sending}
                    onClick={close}
                    className="py-2 px-4 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-nature-300 hover:text-white transition-all min-h-[40px]"
                >
                    {t('Cancel')}
                </button>
            </div>
        </div>
    );
}
