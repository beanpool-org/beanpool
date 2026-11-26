import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useIdentity } from './IdentityContext';
import { fetchMembership } from '../utils/membership-probe';
import { membershipAnswerOf } from '../utils/membership-answer';
import { noteStandingHere } from '../utils/standing-here';
import { provideRecognitionAfresh } from '../utils/recognition-afresh';

/**
 * Whether the active community node recognises this identity as a member.
 *  - 'unknown'  : not checked yet, no node set, or the node was unreachable / answered
 *                 oddly. We deliberately do NOT act on this — never punish a flaky
 *                 connection by treating it as a rejection.
 *  - 'member'   : the node confirmed membership, a suspended account's too: it stays in the app, and Message sends nothing
 *                 across from here while it lasts (utils/message-anyone.ts, which asks for itself; with no answer it goes
 *                 by what was noted here: utils/standing-here.ts).
 *  - 'stranger' : the node is reachable and definitively says this key is NOT a member
 *                 (or refuses it as one: 403 `members_only` / `private_preview`).
 *  - 'closed'   : the node closed this key's account there (403 `account_closed`: removed, or
 *                 deleted by its owner). A definite answer, diverted like 'stranger' to the
 *                 not-recognised screen's closed page (DESIGN-global-entry-fable.md §C.3),
 *                 never read as a connection problem. An owner's retiring of an empty duplicate
 *                 (403 `account_retired`) is 'closed' too, with `retired` set: the same page and
 *                 guards, its own words (core ACCOUNT_RETIRED_WORDS).
 * 'stranger' and 'closed' drive the not-recognised screen. The probe's answer is read by
 * utils/membership-answer.ts, the one reader every place that asks shares.
 */
export type NodeRecognition = 'unknown' | 'member' | 'stranger' | 'closed' | 'recovering';

interface NodeStatusState {
    recognition: NodeRecognition;
    /** 'closed' because an owner retired the account as an empty duplicate (403 `account_retired`); false otherwise. */
    retired: boolean;
    nodeUrl: string | null;
    recheck: () => Promise<NodeRecognition>;
}

const NodeStatusContext = createContext<NodeStatusState>({
    recognition: 'unknown',
    retired: false,
    nodeUrl: null,
    recheck: async () => 'unknown',
});

export function NodeStatusProvider({ children }: { children: React.ReactNode }) {
    const { identity } = useIdentity();
    const [recognition, setRecognition] = useState<NodeRecognition>('unknown');
    const [retired, setRetired] = useState(false);
    const [nodeUrl, setNodeUrl] = useState<string | null>(null);
    const mounted = useRef(true);
    // Each ask takes a turn, and only the latest one writes what it heard: an answer still out when the phone moved on (asked
    // at launch or on a return, then a switch) is the community left's, and never stands for the one now in use.
    const turn = useRef(0);

    useEffect(() => () => { mounted.current = false; }, []);

    const recheck = useCallback(async (): Promise<NodeRecognition> => {
        const mine = ++turn.current;
        const latest = () => mounted.current && mine === turn.current;
        if (!identity?.publicKey) {
            if (latest()) { setRecognition('unknown'); setRetired(false); setNodeUrl(null); }
            return 'unknown';
        }
        const url = await AsyncStorage.getItem('beanpool_anchor_url');
        if (latest()) setNodeUrl(url);
        if (!url) {
            // No node configured at all — onboarding's job, not a rejection.
            if (latest()) { setRecognition('unknown'); setRetired(false); }
            return 'unknown';
        }
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);
            // Signed by the key (utils/membership-probe.ts): the community answers only its own key.
            const res = await fetchMembership(url, identity, controller.signal);
            clearTimeout(timeoutId);
            const answer = await membershipAnswerOf(res);
            if (answer) noteStandingHere(identity.publicKey, url, answer);
            // No definite answer (an odd status, a body that isn't the probe's): don't treat it as a rejection.
            const result: NodeRecognition = !answer ? 'unknown'
                : answer.kind === 'member' ? 'member'
                : answer.kind === 'closed' ? 'closed'
                : answer.recovering ? 'recovering' : 'stranger';
            if (latest()) {
                setRecognition(result);
                setRetired(answer?.kind === 'closed' && answer.retired === true);
            }
            if (result === 'member') {
                const plain = url.replace(/\/+$/, '');
                void import('../utils/nodes')
                    .then(async ({ clearGuestNode }) => {
                        for (const u of new Set([url, plain, `${plain}/`])) {
                            await clearGuestNode(u);
                        }
                    })
                    .catch(() => {});
            }
            // A member here (one let in, brought back by a vote, or switched back onto the phone): no wait after an earlier
            // "no member" answer holds the phone's blocks back from here, and they go now if any are owed (blocklist.ts).
            if (result === 'member') {
                void import('../utils/blocklist')
                    .then(({ blocksAtMember }) => blocksAtMember(identity.publicKey, url))
                    .catch(() => {});
            }
            // No member here, so this community keeps no block list for the key (a removed account's went with it): the
            // phone counts none of its blocks as on it, and sends them again once the key is a member here (blocklist.ts).
            if (result === 'closed' || result === 'stranger') {
                void import('../utils/blocklist')
                    .then(({ communityKeepsNoBlocks }) => communityKeepsNoBlocks(identity.publicKey, url))
                    .catch(() => {});
            }
            return result;
        } catch {
            // Unreachable / network error — leave it as unknown, never 'stranger'.
            if (latest()) { setRecognition('unknown'); setRetired(false); }
            return 'unknown';
        }
    }, [identity?.publicKey]);

    // The one switch has just moved the phone to `url` (utils/use-communities.ts switchCommunity, utils/recognition-afresh.ts):
    // what is held was the community left's, so it goes now, before the bounce through Welcome, back to what a cold start
    // holds ('unknown': the root guard lands an account on the tabs, never holds it on Welcome as a stranger), and nothing
    // asked before the move writes after it. Then `url` is asked, and its answer acts as at any start.
    const askAfresh = useCallback((url: string): Promise<NodeRecognition> => {
        if (mounted.current) { setRecognition('unknown'); setRetired(false); setNodeUrl(url); }
        return recheck();
    }, [recheck]);
    useEffect(() => provideRecognitionAfresh(askAfresh), [askAfresh]);

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
        <NodeStatusContext.Provider value={{ recognition, retired, nodeUrl, recheck }}>
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
