import { normalizeNodeUrl } from './node-client';

export interface NodeProfile {
    id: string;
    name: string;
    url: string;
    adminPassword?: string;
    replicationToken?: string;
    isPrimary?: boolean;
}

const PROFILES_KEY = 'bp_fleet_profiles';

export function loadNodeProfiles(): NodeProfile[] {
    const defaultProfiles: NodeProfile[] = [
        {
            id: 'local-node',
            name: 'Local Sovereign Node',
            url: window.location.port === '3001' ? 'https://localhost:8443' : window.location.origin,
            isPrimary: true,
        },
        {
            id: 'test-node',
            name: 'Test Staging Node (test.beanpool.org)',
            url: 'https://test.beanpool.org',
        }
    ];

    try {
        const raw = localStorage.getItem(PROFILES_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) {
                const normalized = parsed.map((p: NodeProfile) => ({ ...p, url: normalizeNodeUrl(p.url) }));
                const hasLocal = normalized.some((p: NodeProfile) => p.id === 'local-node' || p.url.includes('localhost:8443'));
                if (!hasLocal) {
                    return [defaultProfiles[0], ...normalized];
                }
                return normalized;
            }
        }
    } catch { /* ignore */ }
    
    saveNodeProfiles(defaultProfiles);
    return defaultProfiles;
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
