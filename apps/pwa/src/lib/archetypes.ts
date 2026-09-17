/**
 * Archetype collaboration messages and chat prefill helpers.
 */

export interface ChatPrefillPayload {
    recipient?: string;
    text: string;
}

/**
 * Builds the outreach message from the Collaboration Chemistry card. It names no archetype:
 * nothing a member sends or sees about another member carries a type (docs/the-commons.md).
 */
export function buildSynergyCollabMessage(callsign: string | undefined): string {
    const name = callsign || 'there';
    return `Hey ${name}! I saw on your profile that we could work well together. Let's collaborate! 🤝`;
}

/**
 * Builds the friendly nudge message to encourage a peer to take the archetype quiz.
 * Matches native copy verbatim.
 */
export function buildSynergyNudgeMessage(callsign: string | undefined): string {
    const name = callsign || 'there';
    return `Hey ${name}! Take the 60-second working style quiz on your profile so we can see how we work best together! ⚡`;
}

/**
 * Stores a recipient-scoped prefilled message in sessionStorage.
 */
export function setChatPrefill(text: string, recipient?: string): void {
    const payload: ChatPrefillPayload = { recipient, text };
    sessionStorage.setItem('bp_chat_prefill', JSON.stringify(payload));
}

/**
 * Consumes a prefilled message from sessionStorage if the conversation matches the intended recipient.
 * Prevents prefill drafts from leaking into another chat when switching conversations.
 */
export function consumeChatPrefill(convId?: string, participants?: string[]): string | null {
    const raw = sessionStorage.getItem('bp_chat_prefill');
    if (!raw) return null;

    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') {
            if (!parsed.recipient) {
                sessionStorage.removeItem('bp_chat_prefill');
                return parsed.text;
            }
            const matches =
                (convId && convId === parsed.recipient) ||
                (participants && participants.includes(parsed.recipient));
            if (matches) {
                sessionStorage.removeItem('bp_chat_prefill');
                return parsed.text;
            }
            // Intended for another recipient; do not consume here
            return null;
        }
    } catch {
        // Fallback for plain string format
        sessionStorage.removeItem('bp_chat_prefill');
        return raw;
    }

    return null;
}
