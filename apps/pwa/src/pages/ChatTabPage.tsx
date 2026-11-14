/**
 * The Chat tab on the web (slice T0; scratch/fable-design/DESIGN-forums-messaging-joint-fable.md §2.1, Marty's answers to
 * its questions 1 and 3), the phone's app/(tabs)/chats.tsx in the same words.
 *
 * - **Where this community's forum is on** (`features.forum` in its info; core chatSides: every local community from the
 *   start, members only), the Chats · Forum switch sits at the top of the tab, above today's list: its heading, its chips
 *   and "Message requests", where every outside thing will wait (X4, G2). People stays its own tab here.
 * - **Chats** is MessagesPage, unchanged: the switch is handed to it as `frame` and drawn at the top of its list only, so an
 *   open conversation keeps the whole height it has today. **Forum** is the forum's own page (ForumPage, slice F4).
 * - **No forum** (switched off by its owners, a server from before it, or before the info arrives): MessagesPage exactly as
 *   before, with no switch. The wrapper is `display: contents`, so it adds no box and the page lays out as it always has.
 * - MessagesPage stays mounted on the Forum side (hidden), so going back to Chats keeps the list, its chip and its scroll.
 *   Every way in from elsewhere shows Chats (`navNonce`, bumped by App's navigateToTab at each arrival): a conversation (a
 *   notice, a profile's Message), and the bell's and Home's rows that name no conversation (a message request, the unread
 *   messages, your groups). A tap on the tab itself is not a way in from elsewhere: it leaves the side the member picked.
 *   The forum's notices are the one way in that shows the Forum (`openForum`, slice F5), as on the phone.
 */
import { useEffect, useState, type ComponentProps } from 'react';
import { chatSides, chatSideShown, t, type ChatSide, type ChatSideEntry } from '@beanpool/core';
import { useCommunityInfo } from '../lib/features';
import { MessagesPage } from './MessagesPage';
import { ForumPage } from './ForumPage';

/** Two tabs across, as the phone's: the side shown underlined, the other in the accent's ink (4.5:1 or more in Light and
 *  Dark; --text-muted is 4.3:1 on Light's page, short for words this size at 1280 px); each a 44 px target. Long names
 *  (Tamil's, at 320 px and 1.3x) fit their half at 1.05rem; at 1.2rem they broke inside the word (e2e/chat-frame-shots.mjs).
 *  Its spoken name is the Chat tab's own word on the web, with the tab's context: the web's catalogs hold it so. */
export function ChatFrameSwitch({ sides, side, onChange }: {
    sides: ReadonlyArray<ChatSideEntry>;
    side: ChatSide;
    onChange: (side: ChatSide) => void;
}) {
    return (
        <div role="tablist" aria-label={t('Chat', undefined, 'tab')} data-testid="chat-frame-switch" style={{ display: 'flex', marginBottom: '1rem', borderBottom: '1px solid var(--border-primary)' }}>
            {sides.map((entry) => {
                const active = entry.id === side;
                return (
                    <button
                        key={entry.id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        data-testid={`chat-side-${entry.id}`}
                        onClick={() => { if (!active) onChange(entry.id); }}
                        style={{
                            flex: '1 1 0', minWidth: 0, minHeight: '44px', padding: '0.5rem', marginBottom: '-1px',
                            background: 'none', border: 'none', borderBottom: `3px solid ${active ? 'var(--bp-accent-fill)' : 'transparent'}`,
                            color: active ? 'var(--text-primary)' : 'var(--bp-ink-accent)', fontWeight: active ? 800 : 700, fontSize: '1.05rem',
                            fontFamily: 'inherit', cursor: active ? 'default' : 'pointer', overflowWrap: 'anywhere',
                        }}
                    >
                        {t(entry.label)}
                    </button>
                );
            })}
        </div>
    );
}

export function ChatTabPage({ navNonce, openForum, onForumOpened, ...props }: ComponentProps<typeof MessagesPage> & {
    /** Changes at every arrival at the tab from elsewhere (App's navigateToTab), with a conversation or without one. */
    navNonce?: number;
    /** The arrival was for the Forum (a forum notice, slice F5): the Forum side, once; {@link onForumOpened} then clears it. */
    openForum?: boolean;
    onForumOpened?: () => void;
}) {
    const features = useCommunityInfo()?.features;
    const sides = chatSides(features);
    const [picked, setPicked] = useState<ChatSide>('chats');
    const side = chatSideShown(picked, features);
    useEffect(() => { setPicked('chats'); }, [navNonce]);
    useEffect(() => { if (props.openConversationId) setPicked('chats'); }, [props.openConversationId]);
    // After the arrival's Chats above, in the same render: the Forum wins. Taken once, so the tab's own button later (which
    // draws the tab afresh) is not a Forum arrival. Where the forum is off, the Forum shows Chats (core chatSideShown).
    useEffect(() => {
        if (!openForum) return;
        setPicked('forum');
        onForumOpened?.();
    }, [openForum]);
    const frame = sides.length ? <ChatFrameSwitch sides={sides} side={side} onChange={setPicked} /> : undefined;
    return (
        <>
            <div data-testid="chat-side-chats-page" style={{ display: side === 'chats' ? 'contents' : 'none' }}>
                {/* Only while Chats shows: the Forum side draws its own, so the page never holds two. */}
                <MessagesPage {...props} frame={side === 'chats' ? frame : undefined} />
            </div>
            {side === 'forum' && (
                // MessagesPage's list padding and width, so the switch stays where it was.
                <div className="p-4 md:p-6 max-w-4xl lg:max-w-6xl xl:max-w-7xl mx-auto w-full">
                    {frame}
                    <ForumPage me={props.identity.publicKey} onOpenProfile={props.onOpenProfile} />
                </div>
            )}
        </>
    );
}
