/**
 * Key codes on the web (DESIGN-dm-key-signal-model §5, slice S3): the box that shows a key's 20 digits, and Settings →
 * "My key code", the same card the phone has under Settings → Account Protection, with the phone's words unchanged.
 *
 * Read only. The digits are worked out from the key each time they are shown (lib/key-code.ts, core's namesKeyCode, so they
 * match the phone's for the same key); nothing is stored or sent.
 */
import type { ReactNode } from 'react';
import { t } from '@beanpool/core';
import { keyCodeOf, keyCodeSpoken } from '../lib/key-code';

/**
 * The 20 digits in a box: selectable, wrapping only between groups at 320 px and 1.3x text. A screen reader hears `label`
 * (each digit on its own, as the phone says it) instead of the groups read as numbers: a paragraph can't carry an
 * aria-label (ARIA names are prohibited on it), so the spoken form is its own hidden text, as CreditLines does.
 */
export function KeyCodeBox({ code, label, testId }: { code: string; label: string; testId?: string }): ReactNode {
    return (
        <div className="mt-3 rounded-xl border border-nature-200 dark:border-nature-700 bg-nature-50 dark:bg-nature-950 px-3 py-2">
            <p className="m-0 text-lg font-bold tabular-nums tracking-wide text-nature-950 dark:text-white select-text">
                <span data-testid={testId} aria-hidden="true">{code}</span>
                <span className="sr-only">{label}</span>
            </p>
        </div>
    );
}

/** Settings → "My key code": what a chat partner compares with the code their app shows for this member. */
export function MyKeyCodeCard({ publicKey }: { publicKey?: string | null }): ReactNode {
    const code = keyCodeOf(publicKey);
    // The web always has its own key once Settings shows; a key that isn't one draws nothing rather than a wrong code.
    if (!code) return null;
    return (
        <section
            data-testid="my-key-code"
            aria-labelledby="my-key-code-title"
            className="bg-white dark:bg-nature-900 rounded-2xl px-5 py-4 shadow-sm border border-nature-200 dark:border-nature-800"
        >
            <h3 id="my-key-code-title" className="m-0 text-[15px] font-bold text-nature-900 dark:text-white">
                <span aria-hidden="true">🔢 </span>{t('My key code')}
            </h3>
            <KeyCodeBox code={code} label={t('My key code: {code}', { code: keyCodeSpoken(code) })} testId="my-key-code-digits" />
            {/* nature-600, not the 500 of Settings' row subtitles: 500 on white is 3.3:1, under 4.5:1 for words this small. */}
            <p className="m-0 mt-3 text-xs text-nature-600 dark:text-nature-300 leading-relaxed">
                {t("If a chat with you ever says your key changed, the other person can check this code against the one their phone shows. It isn't secret: it's safe to read out.")}
            </p>
        </section>
    );
}
