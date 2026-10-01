import { normalizeNodeUrl } from './node-client';

export interface NodeProfile {
    id: string;
    name: string;
    url: string;
    /** Fleet mode only, and in memory only (heldCredentials): never written to localStorage. */
    adminPassword?: string;
    /** Same: memory only. */
    replicationToken?: string;
    isPrimary?: boolean;
}

const PROFILES_KEY = 'bp_fleet_profiles';

/**
 * A profile's credentials, by profile id, for this page's lifetime. The profile list itself is kept in localStorage,
 * which on a node is the members' web app's origin too: a password stored there is one script away from that app
 * (Fable's web review, M1). So the list is saved without them, and anything an older build saved is taken out
 * on load (loadNodeProfiles saves the list back). A reload asks for them again.
 */
const heldCredentials = new Map<string, { adminPassword?: string; replicationToken?: string }>();

function withoutCredentials(p: NodeProfile): NodeProfile {
    const copy = { ...p };
    delete copy.adminPassword;
    delete copy.replicationToken;
    return copy;
}

function withHeldCredentials(p: NodeProfile): NodeProfile {
    const held = heldCredentials.get(p.id);
    return held ? { ...p, ...held } : p;
}

export function loadNodeProfiles(): NodeProfile[] {
    const localUrl = normalizeNodeUrl(window.location.port === '3001' ? 'https://localhost:8443' : window.location.origin);
    const defaultProfiles: NodeProfile[] = [
        {
            id: 'local-node',
            name: 'Local Sovereign Node',
            url: localUrl,
            isPrimary: true,
        },
        {
            id: 'test-node',
            name: 'Test Staging Node (test.beanpool.org)',
            url: 'https://test.beanpool.org',
        }
    ];

    let profilesToUse = defaultProfiles.map(withHeldCredentials);
    try {
        const raw = localStorage.getItem(PROFILES_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) {
                profilesToUse = parsed.map((p: NodeProfile) => withHeldCredentials({ ...withoutCredentials(p), url: normalizeNodeUrl(p.url) }));
            }
        }
    } catch { /* ignore */ }

    // Deduplicate profiles by normalized URL so local node is never listed twice when hosted on a domain
    const seenUrls = new Set<string>();
    const deduplicated: NodeProfile[] = [];
    for (const p of profilesToUse) {
        const norm = normalizeNodeUrl(p.url);
        if (!seenUrls.has(norm)) {
            seenUrls.add(norm);
            deduplicated.push(p);
        }
    }

    saveNodeProfiles(deduplicated);
    return deduplicated;
}

const ACTIVE_PROFILE_KEY = 'bp_fleet_active_id';

export function loadActiveProfileId(): string {
    try {
        const id = localStorage.getItem(ACTIVE_PROFILE_KEY);
        if (id) return id;
    } catch { /* ignore */ }
    return 'local-node';
}

export function saveActiveProfileId(id: string): void {
    try {
        localStorage.setItem(ACTIVE_PROFILE_KEY, id);
    } catch { /* ignore */ }
}

export function saveNodeProfiles(profiles: NodeProfile[]): void {
    for (const p of profiles) {
        if (p.adminPassword || p.replicationToken) heldCredentials.set(p.id, { adminPassword: p.adminPassword, replicationToken: p.replicationToken });
        else heldCredentials.delete(p.id);
    }
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles.map(withoutCredentials)));
}

export function updateNodeProfile(id: string, updates: Partial<NodeProfile>): NodeProfile[] {
    const profiles = loadNodeProfiles();
    const updated = profiles.map(p => p.id === id ? { ...p, ...updates } : p);
    saveNodeProfiles(updated);
    return updated;
}

export function addNodeProfile(profile: Omit<NodeProfile, 'id'>): NodeProfile {
    const profiles = loadNodeProfiles();
    const newProfile: NodeProfile = {
        ...profile,
        id: 'node-' + Math.random().toString(36).substring(2, 9),
    };
    profiles.push(newProfile);
    saveNodeProfiles(profiles);
    return newProfile;
}

export function removeNodeProfile(id: string): void {
    const profiles = loadNodeProfiles().filter(p => p.id !== id);
    heldCredentials.delete(id);
    saveNodeProfiles(profiles);
}
