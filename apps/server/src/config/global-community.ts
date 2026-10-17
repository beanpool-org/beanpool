/**
 * The worldwide community this node points its members to (scratch/global-node/DESIGN-global-entry-fable.md §B.3, slice
 * W1): the "Global community" row in the web app's Settings on a local community. Env GLOBAL_COMMUNITY_URL, an https
 * address, read at every request. EMPTY = BeanPool's own global community. `off` (or none, 0, false, no) = none, and the
 * row isn't drawn. A self-hoster who runs another global community names theirs. Anything else that isn't an https
 * address (the same test as Start a community's page, config/start-community.ts) also names none, so a typo never
 * points members at a community the operator didn't mean. Env, as DIRECTORY_MIRROR_URL is, because it says which
 * BeanPool this server belongs to, not something about the community.
 *
 * Nothing on this node ever contacts it (memory no-domain-lock-in): it is a link a member may follow. Reported on GET
 * /api/community/info as `globalCommunityUrl`, absent when none.
 */
import { cleanStartCommunityUrl } from './start-community.js';

export const GLOBAL_COMMUNITY_URL_DEFAULT = 'https://global.beanpool.org';

const OFF = new Set(['off', 'none', '0', 'false', 'no']);

/** The address the web app's "Global community" row opens, or null for none. */
export function getGlobalCommunityUrl(env: NodeJS.ProcessEnv = process.env): string | null {
    const raw = (env.GLOBAL_COMMUNITY_URL ?? '').trim();
    if (!raw) return GLOBAL_COMMUNITY_URL_DEFAULT;
    if (OFF.has(raw.toLowerCase())) return null;
    return cleanStartCommunityUrl(raw);
}
