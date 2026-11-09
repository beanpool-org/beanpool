/**
 * "About this listing" in a chat (@beanpool/core chat-about.ts; Marty, 9 Nov): the chip above the composer after Message
 * on a listing, and the small card at the top of the bubble that carried it. The phone draws the same two things
 * (apps/native/components/ChatAbout.tsx) from the same words.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
    CHAT_ABOUT_WORDS, chatAboutCard, chatAboutChipWords, chatAboutDrafts, t,
    type ChatAbout as ChatAboutRef, type ChatAboutChip,
} from '@beanpool/core';
import { getMarketplacePosts, type MarketplacePost } from '../lib/api';

/** How long a lookup is believed, so a listing that comes back, or goes, is noticed without a request per redraw. */
const LOOKUP_MS = 60_000;

const found = new Map<string, { at: number; post: MarketplacePost | null }>();
const asking = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

/**
 * The listing as THIS reader can read it: the post once found, null when the node has none for them (gone, or hidden from
 * them: the same answer, so a chat learns nothing about a listing it can't see), undefined while the lookup is going or
 * the node could not be asked (the card then shows what the sender wrote, never a refusal).
 */
export function useAboutListing(postId: string | null | undefined): MarketplacePost | null | undefined {
    const [, bump] = useState(0);
    useEffect(() => {
        if (!postId) return;
        const again = () => bump((n) => n + 1);
        listeners.add(again);
        const hit = found.get(postId);
        if ((!hit || Date.now() - hit.at > LOOKUP_MS) && !asking.has(postId)) {
            const ask = getMarketplacePosts({ id: postId, limit: 1 })
                .then((posts) => { found.set(postId, { at: Date.now(), post: posts.find((p) => p.id === postId) ?? null }); })
                .catch(() => { /* not asked yet: the sender's own title stays */ })
                .finally(() => { asking.delete(postId); for (const l of [...listeners]) l(); });
            asking.set(postId, ask);
        }
        return () => { listeners.delete(again); };
    }, [postId]);
    return postId ? found.get(postId)?.post : undefined;
}

/** Forget what was looked up (a test, or a sign-out). */
export function forgetAboutListings(): void {
    found.clear();
    asking.clear();
}

/** The chip waiting for the next message in this conversation, or null. */
export function useChatAboutDraft(conversationId: string | null | undefined): ChatAboutChip | null {
    return useSyncExternalStore(
        chatAboutDrafts.subscribe,
        () => chatAboutDrafts.get(conversationId),
        () => null,
    );
}

const WRAP = { overflowWrap: 'anywhere', wordBreak: 'break-word' } as const;

/** Above the composer: "About: Fresh eggs · 6 Beans", with a ✕ that leaves it out. Stays until sent or dropped. */
export function AboutChipBar({ conversationId }: { conversationId: string }) {
    const chip = useChatAboutDraft(conversationId);
    if (!chip) return null;
    const words = chatAboutChipWords(chip);
    return (
        <div data-testid="chat-about-chip" style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px',
            padding: '0.5rem 1rem', background: 'var(--bg-secondary)', borderTop: '1px solid var(--border-primary)',
            fontSize: '0.85rem', color: 'var(--text-secondary)',
        }}>
            <div style={{ borderLeft: '3px solid var(--accent)', paddingLeft: '8px', minWidth: 0, flex: 1, ...WRAP }}>
                <span aria-hidden="true">🏷️ </span>{words}
            </div>
            <button
                type="button"
                data-testid="chat-about-chip-drop"
                onClick={() => chatAboutDrafts.drop(conversationId)}
                aria-label={t(CHAT_ABOUT_WORDS.drop)}
                title={t(CHAT_ABOUT_WORDS.drop)}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1rem', padding: '6px', minWidth: '44px', minHeight: '44px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
            >
                ✕
            </button>
        </div>
    );
}

/**
 * The card at the top of a bubble. It takes the colours of the bubble it sits in (currentColor), so it reads in the
 * accent bubble and the plain one, light and dark. A tap opens the listing; one this reader can't see opens nothing.
 */
export function AboutCard({ about, onOpen }: { about: ChatAboutRef; onOpen?: (postId: string) => void }) {
    const live = useAboutListing(about.postId);
    const card = chatAboutCard(about, live);
    const box = {
        display: 'block', width: '100%', boxSizing: 'border-box', textAlign: 'start', font: 'inherit', color: 'inherit',
        margin: '0 0 4px', padding: '6px 8px', borderRadius: '8px',
        background: 'color-mix(in srgb, currentColor 14%, transparent)',
        border: '1px solid color-mix(in srgb, currentColor 30%, transparent)',
        ...WRAP,
    } as const;
    if (card.gone) {
        return <div data-testid="chat-about-gone" style={{ ...box, fontStyle: 'italic', opacity: 0.85 }}>{card.goneWords}</div>;
    }
    return (
        <button type="button" data-testid="chat-about-card" aria-label={`${t(CHAT_ABOUT_WORDS.open)}: ${card.title}`} onClick={() => onOpen?.(card.postId)}
            style={{ ...box, cursor: onOpen ? 'pointer' : 'default', minHeight: '44px' }}>
            <span style={{ display: 'block', fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', opacity: 0.8 }}>{card.kindWords}</span>
            <span style={{ display: 'block', fontWeight: 600 }}>{card.title}</span>
            {card.price && <span style={{ display: 'block', fontSize: '0.85rem', opacity: 0.9 }}>{card.price}</span>}
        </button>
    );
}
