import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useIdentity } from './IdentityContext';

/**
 * Whether the active community node recognises this identity as a member.
 *  - 'unknown'  : not checked yet, no node set, or the node was unreachable / answered
 *                 oddly. We deliberately do NOT act on this — never punish a flaky
 *                 connection by treating it as a rejection.
 *  - 'member'   : the node confirmed membership.
 *  - 'stranger' : the node is reachable and definitively says this key is NOT a member.
 *                 Only this state drives the wrong-node recovery screen.
 */
export type NodeRecognition = 'unknown' | 'member' | 'stranger' | 'recovering';

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
            const res = await fetch(`${url}/api/community/membership/${identity.publicKey}`, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            if (!res.ok) {
                // Reachable but the endpoint misbehaved — don't treat as a rejection.
                if (mounted.current) setRecognition('unknown');
                return 'unknown';
            }
            const data = await res.json();
            const result: NodeRecognition = data && data.isMember ? 'member' : data && data.isRecovering ? 'recovering' : 'stranger';
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
