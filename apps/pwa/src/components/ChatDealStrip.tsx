/**
 * The deals in a chat with one person, pinned above the thread: the phone's deal strip (chat/[id].tsx `dealStrip`), same
 * cards, same words, same order (DESIGN-deals-fable §2.2, slice S5). One card per deal that still asks something of the
 * chat: Beans held in trust, a finished trade the member hasn't rated, or a request on their listing waiting for their
 * answer (the list's Action Required counts it, so the chat it opens shows it).
 *
 *  - the payer sees Release and Cancel (core's dealMoves: only the payer releases);
 *  - the payee sees "⏳ Awaiting release": their step is in the world, not in the app;
 *  - a finished trade not yet rated shows "⭐ Review";
 *  - a request to answer says "Waiting on you: answer" (core's dealStateWords) and has no control of its own: nothing is
 *    held yet, and Approve and Deny live on the listing, which the card opens.
 *
 * A card's title and amount open the listing at that deal. Every control is a real button, 44 px tall, with a name that
 * says which deal it acts on; colours are the shared library's roles (light and dark come with them).
 */

import { dealMoves, dealStateWords, dealStep, t, tn } from '@beanpool/core';
import type { MarketplaceTransaction } from '../lib/api';

interface Props {
    /** The deals to show, newest first (MessagesPage decides which). */
    deals: MarketplaceTransaction[];
    me: string;
    /** The other person's name, for a card whose community keeps no Beans in view. */
    peerName: string | null;
    /** The community counts in Beans: an amount is shown. Off, a card says whose step it is instead. */
    showsBeans: boolean;
    /** A release or cancel is on its way: the buttons wait. */
    busy: boolean;
    onOpen: (tx: MarketplaceTransaction) => void;
    onRelease: (tx: MarketplaceTransaction) => void;
    onCancel: (tx: MarketplaceTransaction) => void;
    onReview: (tx: MarketplaceTransaction) => void;
}

const buttonBase = {
    minHeight: '44px', minWidth: '44px', padding: '0.4rem 0.75rem', borderRadius: '8px',
    fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer', fontFamily: 'inherit',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
} as const;

/** A card's second line: the amount and where it stands, as the phone writes it ("5 Beans · in escrow"). */
function metaWords(tx: MarketplaceTransaction, me: string, peerName: string | null, showsBeans: boolean): string {
    // A request holds nothing yet: never "in escrow", whatever Beans it names.
    if (tx.status !== 'requested' && showsBeans && tx.credits > 0) {
        const amount = tn(tx.credits, '{n} Beans', '{n} Beans');
        return tx.status === 'completed' ? t('{amount} · completed', { amount }) : t('{amount} · in escrow', { amount });
    }
    // Nothing to count: whose step it is, in core's words for a deal.
    return dealStateWords(dealStep(tx, me), peerName);
}

export function ChatDealStrip({ deals, me, peerName, showsBeans, busy, onOpen, onRelease, onCancel, onReview }: Props) {
    if (deals.length === 0) return null;
    return (
        <div data-testid="chat-deal-strip" style={{ background: 'var(--bp-chip-ok-tint)', borderBottom: '1px solid var(--border-primary)' }}>
            <div style={{ display: 'flex', gap: '0.5rem', overflowX: 'auto', padding: '0.6rem 0.75rem' }}>
                {deals.map(tx => {
                    const moves = dealMoves(tx, me);
                    // The payer holds the key: Release and Cancel. The payee waits (the phone's rule, not Cancel for either side).
                    const releasable = !!moves && moves.release;
                    const awaiting = tx.status === 'pending' && !releasable;
                    const reviewable = tx.status === 'completed';
                    const title = tx.postTitle || t('Deal');
                    return (
                        <div
                            key={tx.id}
                            role="group"
                            aria-label={title}
                            data-testid={`chat-deal-${tx.id}`}
                            style={{
                                flex: '0 0 auto', width: 'min(12.5rem, 82%)', boxSizing: 'border-box',
                                background: 'var(--bg-primary)', border: '1px solid var(--border-primary)', borderRadius: '12px',
                                padding: '0.5rem 0.65rem', display: 'flex', flexDirection: 'column', gap: '0.35rem',
                            }}
                        >
                            <button
                                type="button"
                                onClick={() => onOpen(tx)}
                                style={{
                                    minHeight: '44px', padding: 0, border: 'none', background: 'none', textAlign: 'left',
                                    cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-primary)', minWidth: 0,
                                }}
                            >
                                <div style={{ fontSize: '0.875rem', fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                                    {metaWords(tx, me, peerName, showsBeans)}
                                </div>
                            </button>
                            {(releasable || awaiting || reviewable) && (
                                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.4rem' }}>
                                    {tx.status === 'pending' && releasable && (
                                        <>
                                            <button
                                                type="button"
                                                disabled={busy}
                                                onClick={() => onRelease(tx)}
                                                aria-label={tx.postTitle ? t('Release credits for {title}', { title: tx.postTitle }) : t('Release credits for deal')}
                                                style={{ ...buttonBase, flex: 1, border: 'none', background: 'var(--bp-commit-fill)', color: 'var(--bp-commit-on)' }}
                                            >
                                                {busy ? '…' : t('Release')}
                                            </button>
                                            <button
                                                type="button"
                                                disabled={busy}
                                                onClick={() => onCancel(tx)}
                                                aria-label={t('Cancel deal')}
                                                style={{ ...buttonBase, border: '1px solid var(--border-primary)', background: 'var(--bp-chip-danger-tint)', color: 'var(--bp-chip-danger-ink)' }}
                                            >
                                                {t('Cancel')}
                                            </button>
                                        </>
                                    )}
                                    {awaiting && (
                                        <span style={{ fontSize: '0.75rem', fontWeight: 600, fontStyle: 'italic', color: 'var(--text-secondary)' }}>{t('⏳ Awaiting release')}</span>
                                    )}
                                    {reviewable && (
                                        <button
                                            type="button"
                                            onClick={() => onReview(tx)}
                                            aria-label={tx.postTitle ? t('Leave a review for {title}', { title: tx.postTitle }) : t('Leave a review for deal')}
                                            style={{ ...buttonBase, flex: 1, border: '1px solid var(--border-primary)', background: 'var(--bp-chip-warn-tint)', color: 'var(--bp-chip-warn-ink)' }}
                                        >
                                            {t('⭐ Review')}
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
