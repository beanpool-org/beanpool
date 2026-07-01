import AsyncStorage from '@react-native-async-storage/async-storage';

export interface SavedNode {
    url: string;
    alias?: string;
    lastConnected?: string;
    currencyType?: 'text' | 'image';
    currencyValue?: string;
}

export async function getSavedNodes(): Promise<SavedNode[]> {
    try {
        const data = await AsyncStorage.getItem('beanpool_saved_nodes');
        const nodes: SavedNode[] = data ? JSON.parse(data) : [];
        
        // Auto-migrate standard legacy active node if it exists
        const currentActiveUrl = await AsyncStorage.getItem('beanpool_anchor_url');
        if (currentActiveUrl && !nodes.find(n => n.url === currentActiveUrl)) {
            nodes.push({ url: currentActiveUrl, lastConnected: new Date().toISOString() });
            await AsyncStorage.setItem('beanpool_saved_nodes', JSON.stringify(nodes));
        }
        return nodes;
    } catch (e) {
        console.error("Failed parsing saved nodes:", e);
        return [];
    }
}

export async function addSavedNode(url: string, alias?: string, currencyType?: 'text'|'image', currencyValue?: string) {
    const nodes = await getSavedNodes();
    const existing = nodes.find(n => n.url === url);
    if (!existing) {
        nodes.push({ url, alias, lastConnected: new Date().toISOString(), currencyType, currencyValue });
    } else {
        existing.lastConnected = new Date().toISOString();
        if (alias) existing.alias = alias;
        if (currencyType) existing.currencyType = currencyType;
        if (currencyValue) existing.currencyValue = currencyValue;
    }
    await AsyncStorage.setItem('beanpool_saved_nodes', JSON.stringify(nodes));
}

export async function removeSavedNode(url: string) {
    let nodes = await getSavedNodes();
    nodes = nodes.filter(n => n.url !== url);
    await AsyncStorage.setItem('beanpool_saved_nodes', JSON.stringify(nodes));
}

/**
 * Returns a sanitized alphanumeric string to safely use as a SQLite filename.
 * e.g., "http://192.168.1.100:3000" -> "beanpool_http_192_168_1_100_3000.db"
 */
export function getDatabaseFilenameForNode(url: string | null): string {
    if (!url) return 'beanpool.db'; // Fallback
    const sanitized = url.replace(/[^a-zA-Z0-9]/g, '_');
    return `beanpool_${sanitized}.db`;
}
