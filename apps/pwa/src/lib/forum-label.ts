/**
 * "Beside my name on the worldwide forum" in the web app (slice F10 apps; @beanpool/core forum-label.ts is what it does and
 * why, and the phone runs the same file). Here is what is the browser's:
 *
 * - **The note** is asked of the community the member picks from the directory (GET /api/global/communities?q=, on the
 *   worldwide community this web app talks to), at that community's own address, signed by this browser's key for that
 *   host, in the member's language so a refusal comes back in it (api.ts signedFetchAt). The member's community opens that
 *   one route to a web app on another origin, `x-language` among its headers (#3199).
 * - **The choice** goes to this web app's own community, the worldwide forum, signed (api.ts signedFetch).
 * - **Renewing** needs the address again: the browser keeps, for its own key, the community's directory key and the
 *   address it was asked at (localStorage, a convenience: gone, and Settings says the note ran out until the member picks
 *   it again). Asked at most once a page load, when the forum is opened and says it is public.
 */
import {
    FORUM_LABEL_PATHS, chooseForumLabel, readForumLabelState, renewForumLabel,
    type ForumLabelAnswer, type ForumLabelChoice, type ForumLabelDeps, type ForumLabelResult, type ForumLabelState,
} from '@beanpool/core';
import { request, signedFetch, signedFetchAt } from './api';
import { loadIdentity } from './identity';

/** One community in the directory, as the picker shows it. */
export interface DirectoryPick { key: string; name: string; url: string }

const KEPT_KEY = 'beanpool_forum_label_at';

async function answerOf(res: Response): Promise<ForumLabelAnswer> {
    return { status: res.status, body: await res.json().catch(() => null) };
}

const deps: ForumLabelDeps = {
    async askNote(address) {
        const identity = await loadIdentity();
        if (!identity?.privateKey) throw new Error('no key in this browser');
        return answerOf(await signedFetchAt('GET', address.replace(/\/+$/, ''), FORUM_LABEL_PATHS.note, '', identity));
    },
    async postLabel(body) {
        return answerOf(await signedFetch('POST', FORUM_LABEL_PATHS.label, body));
    },
};

function keptAddress(member: string, communityKey: string): string | null {
    try {
        const kept = JSON.parse(localStorage.getItem(KEPT_KEY) ?? 'null') as { member?: string; key?: string; address?: string } | null;
        return kept?.member === member && kept.key === communityKey && typeof kept.address === 'string' ? kept.address : null;
    } catch {
        return null;
    }
}

function keepAddress(member: string, state: ForumLabelState, address: string | null): void {
    try {
        if (state.show === 'community' && state.community && address) {
            localStorage.setItem(KEPT_KEY, JSON.stringify({ member, key: state.community.key, address }));
        } else {
            localStorage.removeItem(KEPT_KEY);
        }
    } catch { /* a convenience only */ }
}

/** What the member chose, as the forum says it; null when it can't say (not the worldwide forum, or no answer). */
export async function readForumLabel(): Promise<ForumLabelState | null> {
    const res = await signedFetch('GET', FORUM_LABEL_PATHS.label).catch(() => null);
    return res?.ok ? readForumLabelState(await res.json().catch(() => null)) : null;
}

/** The member's choice, made (core chooseForumLabel), and the community's address kept for renewing. */
export async function setForumLabel(choice: ForumLabelChoice): Promise<ForumLabelResult> {
    const done = await chooseForumLabel(deps, choice);
    const identity = done.ok ? await loadIdentity() : null;
    if (done.ok && identity) keepAddress(identity.publicKey, done.state, choice.show === 'community' ? choice.address : null);
    return done;
}

/** Listed communities whose name holds `q`, from the directory this community keeps; [] for no answer. */
export async function findListedCommunities(q: string): Promise<DirectoryPick[]> {
    const body = await request<{ communities?: unknown }>('GET', `/api/global/communities?q=${encodeURIComponent(q)}&limit=8`).catch(() => null);
    const rows = Array.isArray(body?.communities) ? body.communities as Array<Record<string, unknown>> : [];
    return rows.flatMap((r) => (typeof r.key === 'string' && typeof r.name === 'string' && typeof r.url === 'string' && /^https?:\/\//.test(r.url)
        ? [{ key: r.key, name: r.name, url: r.url }] : []));
}

let renewedThisLoad = false;

/** Renews the community note when it is due, once a page load (core renewForumLabel). Never throws. */
export async function renewForumLabelOnce(): Promise<void> {
    if (renewedThisLoad) return;
    renewedThisLoad = true;
    const identity = await loadIdentity().catch(() => null);
    if (!identity?.publicKey) return;
    const state = await readForumLabel();
    await renewForumLabel(deps, state, (key) => keptAddress(identity.publicKey, key)).catch(() => null);
}
