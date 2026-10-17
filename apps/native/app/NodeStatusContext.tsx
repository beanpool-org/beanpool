import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useIdentity } from './IdentityContext';
import { fetchMembership } from '../utils/membership-probe';
import { membershipAnswerOf } from '../utils/membership-answer';

/**
 * Whether the active community node recognises this identity as a member.
 *  - 'unknown'  : not checked yet, no node set, or the node was unreachable / answered
 *                 oddly. We deliberately do NOT act on this — never punish a flaky
 *                 connection by treating it as a rejection.
 *  - 'member'   : the node confirmed membership.
 *  - 'stranger' : the node is reachable and definitively says this key is NOT a member
 *                 (or refuses it as one: 403 `members_only` / `private_preview`).
 *  - 'closed'   : the node closed this key's account there (403 `account_closed`: removed, or
 *                 deleted by its owner). A definite answer, diverted like 'stranger' to the
 *                 not-recognised screen's closed page (DESIGN-global-entry-fable.md §C.3),
 *                 never read as a connection problem.
 * 'stranger' and 'closed' drive the not-recognised screen. The probe's answer is read by
 * utils/membership-answer.ts, the one reader every place that asks shares.
 */
export type NodeRecognition = 'unknown' | 'member' | 'stranger' | 'closed' | 'recovering';

interface NodeStatusState {
    recognition: NodeRecognition;
    nodeUrl: string | null;
    recheck: () => Promise<NodeRecognition>;
}

const NodeStatusContext = createContext<NodeStatusState>({
    recognition: 'unknown',
    nodeUrl: null,
    recheck: async () => 'unknown',
});

export function NodeStatusProvider({ children }: { children: React.ReactNode }) {
    const { identity } = useIdentity();
    const [recognition, setRecognition] = useState<NodeRecognition>('unknown');
    const [nodeUrl, setNodeUrl] = useState<string | null>(null);
    const mounted = useRef(true);

    useEffect(() => () => { mounted.current = false; }, []);

    const recheck = useCallback(async (): Promise<NodeRecognition> => {
        if (!identity?.publicKey) {
            if (mounted.current) { setRecognition('unknown'); setNodeUrl(null); }
            return 'unknown';
        }
        const url = await AsyncStorage.getItem('beanpool_anchor_url');
        if (mounted.current) setNodeUrl(url);
        if (!url) {
            // No node configured at all — onboarding's job, not a rejection.
            if (mounted.current) setRecognition('unknown');
            return 'unknown';
        }
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);
            // Signed by the key (utils/membership-probe.ts): the community answers only its own key.
            const res = await fetchMembership(url, identity, controller.signal);
            clearTimeout(timeoutId);
            const answer = await membershipAnswerOf(res);
            // No definite answer (an odd status, a body that isn't the probe's): don't treat it as a rejection.
            const result: NodeRecognition = !answer ? 'unknown'
                : answer.kind === 'member' ? 'member'
                : answer.kind === 'closed' ? 'closed'
                : answer.recovering ? 'recovering' : 'stranger';
            if (mounted.current) setRecognition(result);
            return result;
        } catch {
            // Unreachable / network error — leave it as unknown, never 'stranger'.
            if (mounted.current) setRecognition('unknown');
            return 'unknown';
        }
    }, [identity?.publicKey]);

    // Check on identity change, and again whenever the app returns to the foreground
    // (membership can change while away, e.g. an admin removes the member).
    useEffect(() => { recheck(); }, [recheck]);
    useEffect(() => {
        const sub = AppState.addEventListener('change', (next) => {
            if (next === 'active') recheck();
        });
        return () => sub.remove();
    }, [recheck]);

    return (
        <NodeStatusContext.Provider value={{ recognition, nodeUrl, recheck }}>
            {children}
        </NodeStatusContext.Provider>
    );
}

export function useNodeStatus() {
    return useContext(NodeStatusContext);
}

// Satisfy Expo Router's requirement that files under app/ have a default export.
export default function NodeStatusContextRoute() {
    return null;
}
