export function extractNodeOrigin(raw: string): string | null {
    const trimmed = raw.trim();
    if (trimmed.includes('http')) {
        const originMatch = trimmed.match(/^.*?https?:\/\/[^/?#\s]+/);
        if (originMatch) {
            let extracted = originMatch[0];
            const whitespaceIndex = extracted.indexOf('http');
            if (whitespaceIndex > 0) {
                extracted = extracted.substring(whitespaceIndex);
            }
            return extracted;
        }
    }
    return null;
}

export function extractInviteToken(raw: string): string {
    const trimmed = raw.trim();
    
    // 1. Explicit invite= param takes highest precedence
    const inviteMatch = trimmed.match(/[?&]invite=([^&\s]+)/);
    if (inviteMatch) return decodeURIComponent(inviteMatch[1]);
    
    // 2. Look for expected pattern anywhere in the string
    const patternMatch = trimmed.match(/(?:INV|BP)-[A-Z0-9]{4}-[A-Z0-9]{4}/i);
    if (patternMatch) return patternMatch[0];
    
    // 3. Fallback: URL path tail parsing
    if (trimmed.includes('http')) {
        const urlParts = trimmed.split('?')[0].split('/');
        const lastPart = urlParts[urlParts.length - 1];
        if (lastPart.length >= 8 && /^[A-Z0-9-]+$/i.test(lastPart)) return lastPart;
    }
    
    return trimmed; // Give up, return raw
}

export function normaliseInviteCode(raw: string): string {
    const extracted = extractInviteToken(raw);
    const trimmed = extracted.trim();
    
    // If it's a long offline ticket, leave it alone
    if (trimmed.length > 20 && trimmed.startsWith('BP-')) return trimmed;
    
    // Remove formatting characters
    const clean = extracted.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    
    if (clean.startsWith('INV')) {
        const body = clean.slice(3);
        if (body.length < 8) return extracted.trim().toUpperCase();
        return `INV-${body.slice(0, 4)}-${body.slice(4, 8)}`;
    }
    
    if (clean.length === 8) {
        return `INV-${clean.slice(0, 4)}-${clean.slice(4, 8)}`;
    }
    
    return trimmed.toUpperCase();
}
