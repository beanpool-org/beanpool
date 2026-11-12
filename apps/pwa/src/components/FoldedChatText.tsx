/**
 * A long chat message folds with "…more" (Marty, 28 Oct), as on the phone (components/chat/ChatFold.tsx): past twelve
 * lines the words show their first twelve and a "…more" button; the button opens them in place and "less" folds them again.
 * The rule and its constant are core's (chat-fold.ts).
 *
 * HOW IT MEASURES. A text that could run past the fold (mayFoldChatText) is drawn once clamped to twelve lines, and the box
 * says whether it had more to show (scrollHeight past clientHeight). That is the real line count at the bubble's width,
 * whatever the font and zoom. A text that fits goes back to being drawn as it always was; one that does not stays folded.
 * It is measured again when the bubble's width changes. Every other text is just its words, with nothing measured.
 *
 * Open or folded is this component's own state: per message, for as long as the chat is on screen, never stored.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { CHAT_FOLD_LINES, mayFoldChatText, t } from '@beanpool/core';
import { ChatLinkedText, hasChatLink } from './ChatLinkedText';

interface Props {
    text: string;
    /** False for a message that must never fold: one the member is editing, a removed line. Its words are drawn whole. */
    enabled?: boolean;
    /** How the words sit when they are not folded: in the line with the time (a bubble's body) or on their own (a caption). */
    display?: 'inline' | 'block';
    /** The bubble is the member's own (white on the sage fill), or someone else's. */
    mine?: boolean;
    /** The button's ink on a bubble of another colour, a line that failed; it follows `mine` otherwise. A link takes it too. */
    ink?: string;
    /**
     * Draw the http(s) and www. links in the words as links (ChatLinkedText). Off by default: the caller says so for words a
     * person wrote and that opened, never for a line that did not open, a deleted one, or a chat that is still a request.
     */
    links?: boolean;
}

interface Measured {
    text: string;
    width: number;
    long: boolean;
}

const CLAMP: CSSProperties = {
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: CHAT_FOLD_LINES,
    overflow: 'hidden',
};

/** The nearest ancestor with a box of its own: an inline one reports no width. */
function boxAround(el: HTMLElement): HTMLElement {
    let box = el.parentElement;
    while (box && getComputedStyle(box).display === 'inline') box = box.parentElement;
    return box ?? el;
}

export function FoldedChatText({ text, enabled = true, display = 'inline', mine = false, ink, links = false }: Props) {
    const ref = useRef<HTMLSpanElement>(null);
    const [open, setOpen] = useState(false);
    // The button's name is the word it shows (WCAG 2.5.3); the longer phrase describes it.
    const hintId = useId();
    const [measured, setMeasured] = useState<Measured | null>(null);

    const candidate = enabled && mayFoldChatText(text);
    const known = measured && measured.text === text ? measured : null;

    useLayoutEffect(() => {
        const el = ref.current;
        if (!candidate || known || !el) return;
        setMeasured({ text, width: boxAround(el).clientWidth, long: el.scrollHeight > el.clientHeight + 1 });
    }, [candidate, known, text]);

    // A different width moves the lines: measure again.
    useEffect(() => {
        const el = ref.current;
        if (!candidate || !el || typeof ResizeObserver === 'undefined') return;
        const box = boxAround(el);
        const watch = new ResizeObserver(() => {
            setMeasured((current) => (current && Math.abs(box.clientWidth - current.width) > 1 ? null : current));
        });
        watch.observe(box);
        return () => watch.disconnect();
    }, [candidate]);

    const long = known?.long === true;
    const folded = long && !open;
    // Until it is known, the words are drawn clamped so the box can say whether it had more.
    const clamped = candidate && (!known || folded);

    // The words as drawn: with their links when asked and there are any, else exactly the text. (A link inside the clamped
    // box below counts its lines with the words: measured in Chromium 153 and WebKit 26.6, 12 lines either way.) While the
    // words are clamped their links are not Tab stops: focus on one past the fold would scroll the box and leave it scrolled
    // (Opus review of #2990); "…more" is the next stop and opens them.
    const words = links && hasChatLink(text) ? <ChatLinkedText text={text} ink={mine ? 'inherit' : ink} tabbable={!clamped} /> : text;

    if (!candidate) return <>{words}</>;

    const style: CSSProperties = clamped ? CLAMP : { display: long ? 'block' : display };

    return (
        <>
            {/* A span (given a display) so it can sit in a paragraph as well as in a box. */}
            <span ref={ref} style={style} data-testid="chat-text" data-fold={long ? (open ? 'open' : 'folded') : known ? 'whole' : 'measuring'}>{words}</span>
            {long && (
                <button
                    type="button"
                    onClick={() => setOpen(!open)}
                    aria-expanded={open}
                    aria-describedby={hintId}
                    data-testid="chat-fold-toggle"
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        minHeight: '44px',
                        minWidth: '44px',
                        padding: 0,
                        background: 'none',
                        border: 'none',
                        font: 'inherit',
                        // As the bubble's own Reply, React and Edit buttons are drawn.
                        fontWeight: 600,
                        textDecoration: 'underline',
                        textUnderlineOffset: '2px',
                        color: ink ?? (mine ? '#ffffff' : 'var(--bp-accent-fill)'),
                        cursor: 'pointer',
                    }}
                >
                    {open ? t('less', undefined, 'folds a long message again') : t('…more', undefined, 'shows the rest of a long message')}
                </button>
            )}
            {long && <span id={hintId} hidden>{open ? t('Show less') : t('Show the whole message')}</span>}
        </>
    );
}
