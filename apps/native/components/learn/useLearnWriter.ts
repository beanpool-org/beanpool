/**
 * Who is writing in Learn (slice K4): whether this member checks Local knowledge (an owner or admin, whose own page publishes at
 * once and whose button reads "＋ Add local knowledge"), and how many of their own suggestions wait for an answer (Learn's line
 * "1 of yours is waiting for an admin ›"). Asked when the screen comes into view, so a suggestion sent or taken back shows on the
 * way back.
 *
 * The role is the header's own read (utils/node-admin.ts cachedNodeRoleHeard: ten minutes in memory, never on disk). Not heard
 * (offline, an older node) reads as a member: the form then sends a suggestion, and a node that knows better answers
 * `publish_instead`, which the form takes (app/learn/new.tsx). An owner or admin who lost the role inside those ten minutes is
 * answered `admins_only`, and the form sends it as a suggestion instead, once. Either answer forgets the remembered role
 * (forgetLearnRole). Only a member's waiting count is asked for: an owner or admin never has one.
 */
import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import type { KnowledgeDraftMine } from '@beanpool/core';
import { useIdentity } from '../../app/IdentityContext';
import { cachedNodeRoleHeard, forgetNodeRole } from '../../utils/node-admin';
import { anchorUrl } from '../../utils/node-post';
import { signedGet } from '../../utils/db';

export interface LearnWriter {
    /** An owner or admin here. False until heard, and when it can't be. */
    checks: boolean;
    /** The member's own suggestions waiting; 0 until heard, and for an owner or admin. */
    waiting: number;
}

/** GET /api/knowledge/drafts/mine as My suggestions reads it, or null when it can't be had. */
export async function readMyDrafts(signal?: AbortSignal): Promise<{ waiting: KnowledgeDraftMine[]; answered: KnowledgeDraftMine[] } | null> {
    try {
        const res = await signedGet('/api/knowledge/drafts/mine', signal ? { signal } : undefined);
        if (!res.ok) return null;
        const body = await res.json();
        if (!Array.isArray(body?.waiting) || !Array.isArray(body?.answered)) return null;
        return { waiting: body.waiting, answered: body.answered };
    } catch {
        return null;
    }
}

/**
 * The node said otherwise about this member's role (`publish_instead`, or `admins_only` from an owner or admin no longer): the
 * remembered role is out of date, so it is asked again the next time Learn comes into view, not ten minutes later.
 */
export async function forgetLearnRole(identity: { publicKey?: string } | null | undefined): Promise<void> {
    if (!identity?.publicKey) return;
    const url = await anchorUrl().catch(() => null);
    if (url) forgetNodeRole(url, identity.publicKey);
}

export function useLearnWriter(live: boolean): LearnWriter {
    const { identity } = useIdentity();
    const [writer, setWriter] = useState<LearnWriter>({ checks: false, waiting: 0 });
    useFocusEffect(useCallback(() => {
        if (!live || !identity?.publicKey || !identity.privateKey) return undefined;
        let gone = false;
        (async () => {
            const url = await anchorUrl().catch(() => null);
            const role = url ? (await cachedNodeRoleHeard(url, identity))?.role : null;
            const checks = role === 'owner' || role === 'admin';
            const mine = checks ? null : await readMyDrafts();
            if (!gone) setWriter({ checks, waiting: mine?.waiting.length ?? 0 });
        })().catch(() => {});
        return () => { gone = true; };
    }, [live, identity]));
    return writer;
}
