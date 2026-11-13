/**
 * "Print or save your recovery kit", by the 12 words: asks first (the save warning, Cancel / Continue), then prints the
 * kit (lib/recovery-kit.ts). Optional, and never a success message: the print dialog is the answer. Its words are the
 * library's sage ink (docs/brand-colours.md): the blue it had read 2.07:1 on dark's --bg-secondary (rehearsal 14 Oct S12).
 */
import { useEffect, useId, useRef, useState } from 'react';
import { t, word } from '@beanpool/core';
import { KIT_WEB_FAILED_LINE, KIT_WEB_LABEL, KIT_WEB_WARNING, printRecoveryKit } from '../lib/recovery-kit';
import { keyLineWords } from './key-lines';

const target = {
    width: '100%', minHeight: 44, padding: '0.6rem 0.75rem', borderRadius: 10, fontSize: '0.9rem', fontWeight: 700,
    cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'normal', overflowWrap: 'anywhere', lineHeight: 1.3,
} as const;

/**
 * The one question after the kit is printed or saved (DESIGN-home-default-fable.md §2.5; the director's rule, review of
 * #3114): a browser can't tell a print or save cancelled in its dialog from one done, so the kit alone records nothing.
 * Asked once, in the button's place; only Yes says "I still have my 12 words" on the account. Not yet records nothing and
 * asks nothing again. New sentences for slice D4's drafts. Shown through t().
 */
export const KIT_KEPT_WORDS = {
    ask: word('Did you keep it somewhere safe?'),
    yes: word("Yes, it's kept"),
    notYet: word('Not yet'),
} as const;

/**
 * `onKept`: after the kit was printed or saved (the print dialog opened), the member answered Yes to {@link KIT_KEPT_WORDS}:
 * the page keeps that on the account as "I still have my 12 words" (DESIGN-home-default-fable.md §2.5; the node's
 * `words_kept`). Without it, nothing is asked: the kit only prints.
 */
export function RecoveryKitButton({ words, print, onKept }: { words: readonly string[] | null | undefined; print?: (w: Window) => void; onKept?: () => void }) {
    const [asking, setAsking] = useState(false);
    const [failed, setFailed] = useState(false);
    const [askKept, setAskKept] = useState(false);
    // The question takes the place of the buttons the member just pressed: it gets the focus they had.
    const question = useRef<HTMLDivElement | null>(null);
    const askId = useId();
    useEffect(() => { if (askKept) question.current?.focus(); }, [askKept]);
    if (!words || words.length !== 12) return null;

    async function onContinue() {
        setAsking(false);
        const failed = (await printRecoveryKit(words!, print)) === 'failed';
        setFailed(failed);
        if (!failed && onKept) setAskKept(true);
    }

    return (
        <div data-testid="recovery-kit" style={{ marginBottom: '0.75rem' }}>
            {askKept ? (
                <div role="group" aria-labelledby={askId} data-testid="recovery-kit-kept" ref={question} tabIndex={-1} style={{ outline: 'none' }}>
                    <p id={askId} style={{ fontSize: '0.9rem', fontWeight: 700, lineHeight: 1.4, margin: '0 0 0.5rem', overflowWrap: 'anywhere' }}>{t(KIT_KEPT_WORDS.ask)}</p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                        <button type="button" onClick={() => setAskKept(false)}
                            style={{ ...target, flex: '1 1 8em', width: 'auto', border: '1px solid var(--text-muted, #888)', background: 'transparent', color: 'inherit' }}>
                            {t(KIT_KEPT_WORDS.notYet)}
                        </button>
                        <button type="button" onClick={() => { setAskKept(false); onKept?.(); }}
                            style={{ ...target, flex: '1 1 8em', width: 'auto', border: 'none', background: 'var(--bp-info-fill)', color: 'var(--bp-info-on)' }}>
                            {t(KIT_KEPT_WORDS.yes)}
                        </button>
                    </div>
                </div>
            ) : !asking ? (
                <button type="button" onClick={() => { setFailed(false); setAsking(true); }}
                    style={{ ...target, border: '1px solid var(--bp-ink-accent)', background: 'transparent', color: 'var(--bp-ink-accent)' }}>
                    <span aria-hidden="true">🖨️ </span>{keyLineWords(KIT_WEB_LABEL)}
                </button>
            ) : (
                <div role="group" aria-label={keyLineWords(KIT_WEB_LABEL)}>
                    <p style={{ fontSize: '0.8rem', lineHeight: 1.5, margin: '0 0 0.5rem', overflowWrap: 'anywhere' }}>{keyLineWords(KIT_WEB_WARNING)}</p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                        <button type="button" onClick={() => setAsking(false)}
                            style={{ ...target, flex: '1 1 8em', width: 'auto', border: '1px solid var(--text-muted, #888)', background: 'transparent', color: 'inherit' }}>
                            {t('Cancel')}
                        </button>
                        <button type="button" onClick={onContinue}
                            style={{ ...target, flex: '1 1 8em', width: 'auto', border: 'none', background: 'var(--bp-info-fill)', color: 'var(--bp-info-on)' }}>
                            {t('Continue')}
                        </button>
                    </div>
                </div>
            )}
            {failed && <p role="alert" style={{ color: 'var(--bp-ink-danger)', fontSize: '0.8rem', lineHeight: 1.5, margin: '0.5rem 0 0' }}>{keyLineWords(KIT_WEB_FAILED_LINE)}</p>}
        </div>
    );
}
