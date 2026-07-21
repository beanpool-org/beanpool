/**
 * Node Profiles Manager — Stores multi-node connection profiles
 */

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
                // Ensure local-node is always present in profiles
                const hasLocal = parsed.some((p: NodeProfile) => p.id === 'local-node' || p.url.includes('localhost:8443'));
                if (!hasLocal) {
                    return [defaultProfiles[0], ...parsed];
                }
                return parsed;
            }
        }
    } catch { /* ignore */ }
    
    saveNodeProfiles(defaultProfiles);
    return defaultProfiles;
}

export function saveNodeProfiles(profiles: NodeProfile[]): void {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
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
