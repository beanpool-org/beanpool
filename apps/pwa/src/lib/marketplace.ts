/**
 * Marketplace Categories — 16-category spec
 * Blue (#3b82f6) = Offers, Orange (#f97316) = Needs
 */

export const MARKETPLACE_CATEGORIES = [
    { id: 'food', emoji: '🥕', label: 'Food & Produce' },
    { id: 'services', emoji: '🤝', label: 'Services' },
    { id: 'labour', emoji: '👷', label: 'Labour' },
    { id: 'tools', emoji: '🛠️', label: 'Tools' },
    { id: 'goods', emoji: '📦', label: 'Goods' },
    { id: 'garden', emoji: '🌻', label: 'Garden' },
    { id: 'housing', emoji: '🏠', label: 'Housing' },
    { id: 'transport', emoji: '🚗', label: 'Transport' },
    { id: 'education', emoji: '📚', label: 'Education' },
    { id: 'arts', emoji: '🎨', label: 'Arts' },
    { id: 'health', emoji: '🌿', label: 'Health & Wellness' },
    { id: 'care', emoji: '❤️', label: 'Care & Support' },
    { id: 'animals', emoji: '🐾', label: 'Animals' },
    { id: 'tech', emoji: '💻', label: 'Tech & Digital' },
    { id: 'energy', emoji: '☀️', label: 'Energy' },
    { id: 'general', emoji: '🌱', label: 'General' },
] as const;

export type PostType = 'offer' | 'need';

export const POST_TYPE_COLORS = {
    offer: '#10b981',  // Sage Green (Emerald-500)
    need: '#d97757',  // Soft Terracotta
} as const;

export interface MarketplacePost {
    id: string;
    type: PostType;
    category: string;
    title: string;
    description: string;
    credits: number;
    priceType: 'fixed' | 'hourly' | 'daily' | 'weekly' | 'monthly';
    authorCallsign: string;
    authorPublicKey: string;
    location: { lat: number; lng: number } | null;
    createdAt: string;
    photos?: string[];
    status?: 'active' | 'pending' | 'paused' | 'completed' | 'cancelled';
    repeatable?: boolean;
    /** #108: a real cash outlay is involved (fuel / consumables). No amount — terms live in chat. */
    cashAlsoNeeded?: boolean;
    acceptedBy?: string;
    authorEnergyCycled?: number;
    authorFoundingNeeded?: boolean;
    lat?: number;
    lng?: number;
}

/**
 * Format a node origin or peer name into a clean, human-readable label.
 * Handles domain names, multi-addrs, raw IP addresses, and custom callsigns/link names.
 */
export function formatNodeName(origin?: string | null, knownName?: string | null): string {
    if (knownName && typeof knownName === 'string') {
        const cleaned = knownName.replace(/\s+Link$/i, '').trim();
        if (cleaned) return cleaned;
    }
    if (!origin || typeof origin !== 'string') return '';

    const multiAddrMatch = origin.match(/^\/(?:ip4|ip6|dns4|dns6)\/([^/]+)/);
    if (multiAddrMatch) {
        const host = multiAddrMatch[1];
        return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ? `peer (${host})` : host;
    }

    let name = origin.replace(/^https?:\/\//, '').replace(/\.beanpool\.org.*$/, '').replace(/:\d+.*$/, '');
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)) {
        return `peer (${name})`;
    }
    return name;
}
