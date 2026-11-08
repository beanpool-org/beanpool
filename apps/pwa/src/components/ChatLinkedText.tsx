/**
 * The links in a chat message's words, on the web (Marty, 9 Nov: on the phone a link in a message is underlined and opens;
 * on the web it was plain words). The phone's half is components/chat/ChatBubble.tsx; both split the words with core's
 * chat-links.ts, so a link is the same words and goes to the same address on both.
 *
 * A link is an `<a>` that opens in a new tab (`noopener noreferrer`: the page it opens learns nothing about this one). Its
 * address is the one core gives the run (a bare `www.` gets https, a full stop ending a sentence is left off), and a run
 * that has no http(s) address is just words. The link is underlined, so it does not rest on colour alone; long ones wrap
 * anywhere (`overflow-wrap: anywhere`, which also lets the bubble shrink to fit) so nothing scrolls sideways at 320 px.
 *
 * Nothing here opens a menu or starts a copy: the web bubble has no tap or hold of its own (Reply, React, Copy are buttons
 * beside it), and a click on a link does only what a link does.
 */

import { Fragment } from 'react';
import { normaliseTappedUrl, splitTextWithLinks } from '@beanpool/core';

interface Props {
    text: string;
    /**
     * The link's colour. The central `--link` on a bubble of the page's own colour; `inherit` on the member's own
     * bubble (the accent colour, white words: the phone's `linkMe`, the same ink bolder), where a blue would not read.
     */
    ink?: string;
    /**
     * False for words drawn clamped under "…more" (FoldedChatText): a link there is not a Tab stop. The clamped box is a scroll
     * container, so focusing a link past the fold scrolls the box to show it and nothing scrolls it back; "…more" is the next
     * stop instead, and opens every link. True (a Tab stop) everywhere else.
     */
    tabbable?: boolean;
}

/** True when `text` has a run that links: callers use it to leave a text without links exactly as it was drawn. */
export function hasChatLink(text: string | null | undefined): boolean {
    return splitTextWithLinks(text).some((run) => run.isUrl && normaliseTappedUrl(run.text) !== null);
}

export function ChatLinkedText({ text, ink = 'var(--link)', tabbable = true }: Props) {
    return (
        <>
            {splitTextWithLinks(text).map((run, i) => {
                const href = run.isUrl ? normaliseTappedUrl(run.text) : null;
                if (!href) return <Fragment key={i}>{run.text}</Fragment>;
                return (
                    <a
                        key={i}
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        tabIndex={tabbable ? undefined : -1}
                        data-testid="chat-link"
                        className="bp-chat-link"
                        style={{
                            color: ink,
                            textDecoration: 'underline',
                            textUnderlineOffset: '2px',
                            overflowWrap: 'anywhere',
                            // On the accent bubble the link is the bubble's own white, so weight is what sets it apart.
                            fontWeight: ink === 'inherit' ? 600 : undefined,
                        }}
                    >
                        {run.text}
                    </a>
                );
            })}
        </>
    );
}
