/**
 * MCP-OWNER-POSTS: a listing an owner's AI assistant posted reaches the web app as any listing does. The node keeps who made
 * it (posts.created_via) for moderators only; a copy that carried it anyway draws the same card, and nothing on it says an
 * assistant made it.
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarketplaceCard } from './MarketplaceCard';
import type { MarketplacePost } from '../lib/marketplace';

const post = {
    id: 'p-assistant', type: 'offer', category: 'food', title: 'Quincefield sourdough loaves', description: 'Baked Saturday morning', credits: 6,
    priceType: 'fixed', authorPublicKey: 'a'.repeat(64), authorCallsign: 'Olive', active: true, status: 'active',
    createdAt: new Date().toISOString(), photos: ['/api/marketplace/posts/p-assistant/photos/0?v=1&k=KEY0'],
} as unknown as MarketplacePost;

describe('MarketplaceCard: a listing an owner\'s assistant posted', () => {
    it.each(['grid', 'list', 'compact'] as const)('the %s card is the same card, and never says an assistant made it', (viewMode) => {
        const plain = render(<MarketplaceCard post={post} viewMode={viewMode} />);
        const plainHtml = plain.container.innerHTML;
        plain.unmount();
        const made = render(<MarketplaceCard post={{ ...post, createdVia: 'assistant:0123456789ab' } as unknown as MarketplacePost} viewMode={viewMode} />);
        expect(made.container.innerHTML).toBe(plainHtml);
        expect(made.container.textContent).toContain('Quincefield sourdough loaves');
        expect(made.container.textContent ?? '').not.toMatch(/assistant/i);
    });
});
