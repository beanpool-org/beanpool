/**
 * "Copy" on a chat message: the words go to the clipboard, and the button says "Copied" for a moment (Marty, 9 Nov).
 *
 * One button for every web chat (a one-to-one chat, a group chat, an event chat), so they cannot disagree. The page decides
 * whether a message has words worth copying (lib/copy-chat-text.ts copyableChatText) and draws the button only then. The
 * page gives it the look of the buttons beside it; this owns the clipboard, the answer and the screen-reader announcement.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { t } from '@beanpool/core';
import { copyChatText } from '../lib/copy-chat-text';

/** How long "Copied" stays before the button goes back to "Copy". */
export const COPIED_SHOWN_MS = 1800;

interface Props {
    /** The message's words, as the bubble shows them. */
    text: string;
    style?: CSSProperties;
    className?: string;
}

type Answer = 'idle' | 'copied' | 'failed';

export function CopyMessageButton({ text, style, className }: Props) {
    const [answer, setAnswer] = useState<Answer>('idle');
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

    const copy = async () => {
        const done = await copyChatText(text);
        setAnswer(done ? 'copied' : 'failed');
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setAnswer('idle'), COPIED_SHOWN_MS);
    };

    const said = answer === 'copied' ? t('Copied') : answer === 'failed' ? t('Could not copy') : '';

    return (
        <>
            <button
                type="button"
                data-testid="chat-copy"
                onClick={() => { void copy(); }}
                // The name holds the word the button shows (WCAG 2.5.3): "Copy message" holds "Copy", and "Copied" is its own name.
                aria-label={said || t('Copy message')}
                style={style}
                className={className}
            >
                {said || t('Copy', undefined, 'button: copy a message')}
            </button>
            {/* Announced, not just drawn: the button's own name stays "Copy message". */}
            <span role="status" className="sr-only">{said}</span>
        </>
    );
}
