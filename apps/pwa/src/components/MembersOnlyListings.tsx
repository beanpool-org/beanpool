/**
 * A local community's listings are its members' (Marty, 2026-09-28). The node refuses them to anyone else with
 * `code: 'members_only'` (apps/server https-server.ts LISTINGS_MEMBERS_ONLY), and the web app turns that into a short
 * page of its own: what this is, and where a stranger can look around instead, the global community.
 */

/** The worldwide community's one address, where anyone can look around and join with one sign-in. */
export const GLOBAL_COMMUNITY_URL = 'https://global.beanpool.org';

/** Whether a failed request was the node refusing its listings to a non-member (lib/api.ts refusalError keeps `code`). */
export function isMembersOnlyRefusal(e: unknown): boolean {
    return !!e && typeof e === 'object' && (e as { code?: unknown }).code === 'members_only';
}

/** The link to the global community, as a full-width button that wraps at any width. */
export function LookAroundGlobal({ compact = false }: { compact?: boolean }) {
    return (
        <a
            href={GLOBAL_COMMUNITY_URL}
            rel="noopener noreferrer"
            data-testid="look-around-global"
            className="block w-full text-center rounded-xl border border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-900 text-nature-800 dark:text-nature-100 font-bold hover:bg-nature-100 dark:hover:bg-nature-800 transition-colors"
            style={{ padding: compact ? '0.6rem 0.75rem' : '0.8rem 1rem', overflowWrap: 'anywhere', textDecoration: 'none' }}
        >
            🌍 Look around the global community
        </a>
    );
}

/** What the Market shows someone who isn't a member here, in place of the listings. */
export function MembersOnlyListings() {
    return (
        <div data-testid="members-only-listings" className="bg-nature-50 dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-5 mb-4 text-center shadow-sm">
            <p className="text-lg font-bold text-nature-900 dark:text-white mb-2" style={{ overflowWrap: 'anywhere' }}>
                🔒 This community's listings are for its members
            </p>
            <p className="text-sm text-nature-600 dark:text-nature-300 mb-4" style={{ overflowWrap: 'anywhere' }}>
                To join, ask a member for an invite. Anyone can look around the global community, and ask a community near
                them to let them in from there.
            </p>
            <LookAroundGlobal />
        </div>
    );
}
