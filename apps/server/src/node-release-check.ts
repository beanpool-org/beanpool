/**
 * Every node's "is there a newer version" check (routes/settings.ts: POST /api/admin/check-update, and the background
 * check whose answer GET /api/version carries).
 *
 * Not every GitHub release of this repo is a node release: the vault ships as vault-v<semver> and the phone app is
 * tagged native-v<semver>. The check used to read releases/latest, which is whichever release GitHub marks Latest (by
 * date and semver unless the release says otherwise), so a vault release could become it and every node, ours and
 * self-hosters', would read "vault-v1.0.0" as the newest node version (scratch/vault-golive/BLOCKERS.md, Hazards 1).
 * Now it lists the releases and takes the highest v<major>.<minor>.<patch> that is neither a draft nor a prerelease,
 * by version, not by date, ignoring every other tag. With no node release in the list it reads the tags the same way,
 * as it did when there were no releases at all. Still one request a check (two when it falls back to the tags), and
 * the answer keeps its shape.
 */
import { getVersion } from './version.js';

const REPO_API = 'https://api.github.com/repos/beanpool-org/beanpool';
const HEADERS = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'BeanPool-Node' };
/** A node release tag: v1.2.27. Not vault-v1.0.0, native-v1.2.28, v1.3.0-rc.1 or 1.2.27. */
const NODE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

export interface NodeRelease {
    /** Without the v ('1.2.27'); '' when GitHub answered but holds no node release or tag. */
    latestVersion: string;
    releaseNotes: string;
    releaseUrl: string;
    publishedAt: string;
}

function nodeVersion(tag: unknown): number[] | null {
    const m = typeof tag === 'string' ? NODE_TAG.exec(tag) : null;
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function newer(a: number[], b: number[]): boolean {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
}

/** The highest v<semver> of a GitHub releases list that is neither a draft nor a prerelease, or null. */
export function newestNodeRelease(releases: unknown): NodeRelease | null {
    if (!Array.isArray(releases)) return null;
    let best: { v: number[]; r: any } | null = null;
    for (const r of releases) {
        if (!r || r.draft || r.prerelease) continue;
        const v = nodeVersion(r.tag_name);
        if (v && (!best || newer(v, best.v))) best = { v, r };
    }
    if (!best) return null;
    return {
        latestVersion: best.v.join('.'),
        releaseNotes: best.r.body || '',
        releaseUrl: best.r.html_url || '',
        publishedAt: best.r.published_at || '',
    };
}

/** The highest v<semver> of a GitHub tags list, without the v, or '' when it holds none. */
export function newestNodeTag(tags: unknown): string {
    let best: number[] | null = null;
    for (const t of Array.isArray(tags) ? tags : []) {
        const v = nodeVersion(t?.name);
        if (v && (!best || newer(v, best))) best = v;
    }
    return best ? best.join('.') : '';
}

/**
 * The newest node release GitHub holds, or null when GitHub could not be asked (the releases and the tags both
 * answered an error). Throws as fetch or a body that is not JSON throws.
 */
export async function lookUpNewestNodeRelease(): Promise<NodeRelease | null> {
    const response = await fetch(`${REPO_API}/releases?per_page=100`, { headers: HEADERS });
    if (response.ok) {
        const release = newestNodeRelease(await response.json());
        if (release) return release;
    }
    // No node release yet (or the releases could not be read): the tags instead.
    const tagsResponse = await fetch(`${REPO_API}/tags?per_page=100`, { headers: HEADERS });
    if (!tagsResponse.ok) return null;
    return { latestVersion: newestNodeTag(await tagsResponse.json()), releaseNotes: '', releaseUrl: '', publishedAt: '' };
}

export function semverGreater(a: string, b: string): boolean {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) > (pb[i] || 0)) return true;
        if ((pa[i] || 0) < (pb[i] || 0)) return false;
    }
    return false;
}

// ===================== BACKGROUND UPDATE CHECKER =====================
let cachedUpdateInfo: {
    updateAvailable: boolean;
    latestVersion: string;
    releaseNotes: string;
    releaseUrl: string;
    publishedAt: string;
    lastChecked: string;
} | null = null;

/** What the last background check found, for GET /api/version; null until one has reached GitHub. */
export function cachedNodeUpdateInfo() {
    return cachedUpdateInfo;
}

/** One background check. When GitHub can't be asked, the last answer stays. Never throws. */
export async function backgroundUpdateCheck(): Promise<void> {
    try {
        const release = await lookUpNewestNodeRelease();
        if (release) {
            cachedUpdateInfo = {
                updateAvailable: semverGreater(release.latestVersion, getVersion()),
                ...release,
                lastChecked: new Date().toISOString(),
            };
        }
        if (cachedUpdateInfo?.updateAvailable) {
            console.log(`[Update] New version available: v${cachedUpdateInfo.latestVersion} (current: v${getVersion()})`);
        }
    } catch (e: any) {
        console.log(`[Update] Background check failed: ${e.message || 'unknown error'}`);
    }
}
