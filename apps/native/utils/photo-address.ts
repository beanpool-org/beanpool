/**
 * Where a picture a node gave is drawn from. A node gives its own pictures as paths ("/api/marketplace/posts/<id>/photos/<n>?v=…&k=…"),
 * which a phone can't draw from: the community's address goes in front. The community is the one whose copy or answer the picture was
 * in (a held community's own, never the one in use instead). A whole address (http, https) and a `data:` picture are left as they are,
 * and so is a path while no community's address is known.
 *
 * The one rule for the copy's listings and pages (utils/db.ts), the picture hooks (utils/node-uri.ts) and Learn's page and Edit
 * (components/learn/learn-keep.ts pagePhotoUri). Pure.
 */
export function photoOnCommunity(community: string | null | undefined, photo: string): string {
    return photo && photo.startsWith('/') && community ? `${community.replace(/\/+$/, '')}${photo}` : photo;
}
