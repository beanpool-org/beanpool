import type { Treasury, Group, YourChat } from './api';

export interface KeptEnterpriseRow {
    chat: YourChat;
    summary?: Treasury;
}

/**
 * Splits "Yours" into kept enterprises/projects (lead first, then by name) and chat groups (convenor first, then by name).
 * Events are omitted completely (§6.1 Q3: they stay in Talk → Groups, Home and the Market).
 * Each kept enterprise is joined to its Treasury summary by publicKey/id.
 */
export function yoursRows(
    yourChats: ReadonlyArray<YourChat> | null | undefined,
    treasuries: ReadonlyArray<Treasury>,
    myPubkey?: string | null,
    allGroups?: ReadonlyArray<Group>,
): { kept: KeptEnterpriseRow[]; groups: YourChat[] } {
    const summaryMap = new Map<string, Treasury>();
    for (const ent of treasuries) {
        summaryMap.set(ent.publicKey, ent);
    }

    const kept: KeptEnterpriseRow[] = [];
    const groups: YourChat[] = [];
    const seenKept = new Set<string>();
    const seenGroups = new Set<string>();

    if (yourChats) {
        for (const chat of yourChats) {
            if (chat.kind === 'event') continue;
            if (chat.kind === 'enterprise') {
                seenKept.add(chat.id);
                kept.push({ chat, summary: summaryMap.get(chat.id) });
            } else if (chat.kind === 'group') {
                seenGroups.add(chat.id);
                groups.push(chat);
            }
        }
    }

    // Also include any kept enterprise from treasuries list if yourChats has not loaded
    if (!yourChats && myPubkey) {
        for (const ent of treasuries) {
            if (seenKept.has(ent.publicKey)) continue;
            const myKeeper = ent.keepers?.find(k => (k.publicKey || k.pubkey) === myPubkey && !k.suspended);
            if (myKeeper) {
                seenKept.add(ent.publicKey);
                const isProject = ent.lifecycle === 'bounded' || (ent.goalAmount != null && ent.goalAmount > 0);
                kept.push({
                    chat: {
                        kind: 'enterprise',
                        id: ent.publicKey,
                        conversationId: ent.publicKey,
                        name: ent.name,
                        avatarUrl: ent.avatar || ent.avatarUrl || null,
                        role: myKeeper.role === 'lead' ? 'lead' : 'keeper',
                        lifecycle: isProject ? 'bounded' : 'ongoing',
                        badge: isProject ? '🌱' : '🏛️',
                        readOnly: false,
                        unreadCount: 0,
                        lastActivityAt: '',
                    },
                    summary: ent,
                });
            }
        }
    }

    // Also include active group memberships from groups list if not already present from yourChats
    if (myPubkey && allGroups) {
        for (const g of allGroups) {
            if (seenGroups.has(g.id)) continue;
            if (g.viewerStatus === 'active' || (!g.viewerStatus && !!g.viewerRole)) {
                seenGroups.add(g.id);
                groups.push({
                    kind: 'group',
                    id: g.id,
                    conversationId: g.id,
                    name: g.name,
                    avatarUrl: g.avatarUrl || null,
                    badge: null,
                    role: g.viewerRole || 'member',
                    category: g.category,
                    joinPolicy: g.joinPolicy,
                    readOnly: false,
                    unreadCount: 0,
                    lastActivityAt: '',
                });
            }
        }
    }

    kept.sort((a, b) => {
        const aLead = a.chat.role === 'lead';
        const bLead = b.chat.role === 'lead';
        if (aLead !== bLead) return aLead ? -1 : 1;
        return (a.chat.name ?? '').localeCompare(b.chat.name ?? '');
    });

    groups.sort((a, b) => {
        const aConv = a.role === 'convenor';
        const bConv = b.role === 'convenor';
        if (aConv !== bConv) return aConv ? -1 : 1;
        return (a.name ?? '').localeCompare(b.name ?? '');
    });

    return { kept, groups };
}
