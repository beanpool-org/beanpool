/**
 * A member's face URL as the node hands it to members, for server suites that read `/api/avatar/<key>` in the node's own
 * process. Faces are keyed on every node (public-routes audit SEC-PUB-02): the route serves a photo only to a URL with
 * the key for that photo as it is now (`k=`, engine/avatar-keys.ts), as the members list, profiles and feeds hand it out.
 *
 * `withAvatarKey(path)` adds that key to an `/api/avatar/<key>…` path, worked out when it is called (a changed photo has
 * a new key). A path that carries a key already (one a route handed out), or whose member has no photo or isn't a member,
 * is left as it is: the route answers the last two 404, as it answers any URL without its key. Call it after
 * initStateEngine() (which installs the keys) and in the same process.
 */
import { avatarUrlOf } from '@beanpool/core';
import { db } from './db/db.js';

export function withAvatarKey(urlPath: string): string {
    const pk = urlPath.match(/^\/api\/avatar\/([^?/]+)/)?.[1];
    if (!pk || /[?&]k=/.test(urlPath)) return urlPath;
    const ref = (db.prepare('SELECT avatar_ref FROM members WHERE public_key = ?').get(pk) as { avatar_ref: string | null } | undefined)?.avatar_ref;
    const k = ref ? avatarUrlOf(pk, ref)?.match(/[?&]k=([A-Za-z0-9_-]{22})/)?.[1] : undefined;
    return k ? `${urlPath}${urlPath.includes('?') ? '&' : '?'}k=${k}` : urlPath;
}
