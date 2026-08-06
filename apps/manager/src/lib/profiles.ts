import { normalizeNodeUrl } from './node-client';

export interface NodeProfile {
    id: string;
    name: string;
    url: string;
    adminPassword?: string;
    replicationToken?: string;
    isPrimary?: boolean;
    /** 2FA session token issued after successful password + TOTP login.
     *  Stored in localStorage and sent as X-Admin-2FA-Session on API calls
     *  to skip TOTP re-entry within the 4-hour session window. */
    tfaSessionToken?: string;
}

const PROFILES_KEY = 'bp_fleet_profiles';

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

    let profilesToUse = defaultProfiles;
    try {
        const raw = localStorage.getItem(PROFILES_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) {
                const normalized = parsed.map((p: NodeProfile) => ({ ...p, url: normalizeNodeUrl(p.url) }));
                const hasLocal = normalized.some((p: NodeProfile) => p.id === 'local-node' || p.url === localUrl);
                if (!hasLocal) {
                    profilesToUse = [defaultProfiles[0], ...normalized];
                } else {
                    profilesToUse = normalized;
                }
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
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
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
    saveNodeProfiles(profiles);
}
