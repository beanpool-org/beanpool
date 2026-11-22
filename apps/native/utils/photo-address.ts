/**
 * Where a picture a node gave is drawn from. A node gives its own pictures as paths ("/api/marketplace/posts/<id>/photos/<n>?v=…&k=…"),
 * which a phone can't draw from: the community's address goes in front. The community is the one whose copy or answer the picture was
 * in (a held community's own, never the one in use instead). A whole address (http, https) and a `data:` picture are left as they are,
 * and so is a path while no community's address is known.
 *
 * So that it is always that one, the address is taken WITH the copy or the answer, never read as the picture is drawn: after Settings,
 * Advanced, connect, the tabs stay up with what they read from the community left, and a picture's path goes with its key (`k`), which
 * must never be asked of another community's server (review of #3355). A copy's listings and pages are made whole as they are read
 * (utils/db.ts, chatCopyForRequest). A node's answer carries the address it was asked of as `nodeUrl` (a page: KnowledgePage; a Pulse
 * item: PulseFeedItem; Home's: StoredHome.url), and a search's rows are made whole as they land (rowOnCommunity).
 * photo-address-class.test.ts and learn-pictures-drawn-render.test.ts hold every place to it.
 *
 * The one rule for the copy's listings and pages (utils/db.ts), the shops' pictures (utils/node-uri.ts, utils/shopfront.ts) and Learn's
 * page, rows, Edit and Pulse card (components/learn/learn-keep.ts pagePhotoUri). Pure.
 */
export function photoOnCommunity(community: string | null | undefined, photo: string): string {
    return photo && photo.startsWith('/') && community ? `${community.replace(/\/+$/, '')}${photo}` : photo;
}

/** A Learn row a node answered (a search's, Home's), its picture on `community`, the one that answered: the row card is given whole addresses only. */
export function rowOnCommunity<T extends { photo: string | null }>(community: string | null | undefined, row: T): T {
    return typeof row?.photo === 'string' ? { ...row, photo: photoOnCommunity(community, row.photo) } : row;
}
