/**
 * The web join box's invite code (pages/WelcomePage.tsx): what the field shows as a member types, pastes or opens a
 * `?invite=` link (formatInviteCode), and what Join sends to the node's check and redeem (normaliseInviteCode).
 *
 * Anything that isn't an `INV-` code is shaped as an offline ticket, `BP-` and the first 8 letters and digits, so
 * the sample community's example code `EXAMPLE-1234` reads `BP-EXAM-PLE1`: a node refuses that as malformed, since a
 * ticket is signed (components/ShowcasePreviews.test.tsx runs every spelling of each example code through the node's
 * own check).
 */

export function extractInviteToken(raw: string): string {
    const inviteMatch = raw.match(/[?&]invite=([^&]+)/);
    if (inviteMatch) {
        return decodeURIComponent(inviteMatch[1]);
    }
    return raw;
}

/** Strip everything except alphanumeric, uppercase, and format as BP-XXXX-XXXX */
export function formatInviteCode(raw: string): string {
    const extracted = extractInviteToken(raw);
    const trimmed = extracted.trim();
    if (trimmed.length > 20 && trimmed.startsWith('BP-')) {
        return trimmed; // It's an offline cryptographic ticket. Just return it cleanly.
    }

    // Strip non-alphanumeric
    const clean = extracted.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    
    // Legacy support for Node Genesis invites
    if (clean.startsWith('INV')) {
        const body = clean.slice(3);
        if (body.length === 0) return '';
        if (body.length <= 4) return `INV-${body}`;
        return `INV-${body.slice(0, 4)}-${body.slice(4, 8)}`;
    }

    const withoutPrefix = clean.startsWith('BP') ? clean.slice(2) : clean;
    const body = withoutPrefix.slice(0, 8);

    if (body.length === 0) return '';
    if (body.length <= 4) return `BP-${body}`;
    return `BP-${body.slice(0, 4)}-${body.slice(4)}`;
}

/** Normalise any input to the canonical format for API submission */
export function normaliseInviteCode(raw: string): string {
    const extracted = extractInviteToken(raw);
    const trimmed = extracted.trim();
    if (trimmed.length > 20 && trimmed.startsWith('BP-')) {
        return trimmed; // Offline cryptographic bulk token
    }

    const clean = extracted.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    
    if (clean.startsWith('INV')) {
        const body = clean.slice(3);
        if (body.length < 8) return extracted.trim().toUpperCase();
        return `INV-${body.slice(0, 4)}-${body.slice(4, 8)}`;
    }

    const withoutPrefix = clean.startsWith('BP') ? clean.slice(2) : clean;
    const body = withoutPrefix.slice(0, 8);
    if (body.length < 8) return extracted.trim().toUpperCase(); // partial — return as-is
    return `BP-${body.slice(0, 4)}-${body.slice(4)}`;
}
