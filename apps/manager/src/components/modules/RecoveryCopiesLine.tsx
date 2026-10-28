import React, { useEffect, useState } from 'react';
import { resolveNodeApiUrl } from '../../lib/node-client';
import { RECOVERY_COPIES_CHOICES, readRecoveryCopies, type RecoveryCopies } from '../../lib/community-shape';

/**
 * The community's rule for where members' copies go, as the node says it in /api/community/info (`recoveryCopies`), or
 * null when it doesn't say (a node from before the rule) or couldn't be asked. Asked once, when `nodeUrl` is set.
 */
export function useRecoveryCopies(nodeUrl: string): RecoveryCopies | null {
    const [rule, setRule] = useState<RecoveryCopies | null>(null);
    useEffect(() => {
        let live = true;
        setRule(null);
        (async () => {
            try {
                const res = await fetch(resolveNodeApiUrl(nodeUrl, '/api/community/info'), { headers: { Accept: 'application/json' } });
                const body = res.ok ? await res.json().catch(() => null) : null;
                if (live) setRule(readRecoveryCopies(body?.recoveryCopies));
            } catch {
                if (live) setRule(null);
            }
        })();
        return () => { live = false; };
    }, [nodeUrl]);
    return rule;
}

/**
 * The claim wizard's line on where members' copies go (vault rethink VR2, design §5.3): the rule, its honest words, and
 * where an owner changes it (How this community works). Before the first members join, so the owner knows where a
 * sign-in a member links keeps its copy. Nothing is drawn for a node that doesn't say: there each app's build decides,
 * as before the rule.
 */
export function RecoveryCopiesLine({ rule }: { rule: RecoveryCopies | null }) {
    const choice = rule ? RECOVERY_COPIES_CHOICES.find((c) => c.rule === rule) : undefined;
    if (!choice) return null;
    return (
        <div data-testid="recovery-copies-line" className="p-4 rounded-2xl bg-nature-950 border border-nature-800 space-y-1.5 min-w-0">
            <p className="text-xs font-bold text-white m-0 break-words">
                <span aria-hidden="true">🗝️ </span>Where members' copies go: {choice.name}
            </p>
            <p className="text-[11px] text-nature-400 m-0 leading-relaxed break-words">{choice.words}</p>
            <p className="text-[11px] text-nature-400 m-0 leading-relaxed break-words">
                You can change it any time under <strong>How this community works → Ways back</strong>. Members are told, and
                nobody's copy moves by itself.
            </p>
        </div>
    );
}
