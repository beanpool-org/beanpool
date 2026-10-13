/**
 * The reader's own features (scratch/global-node/DESIGN-global-showcase-fable.md §4): the node's set from
 * `GET /api/community/info` (useNodeProfile) and this account's from `GET /api/community/me` (W1's `features`, signed by
 * the account), so a screen's mode is per reader: when a node switches Beans on for one verified member, that member's
 * Ledger goes live and nobody else's changes. The reader's set decides, switch by switch (effectiveFeatures).
 *
 * Signed out, before the answer, or from an older node that doesn't say: the node's set alone, as before.
 */
import React, { useMemo, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ShowcaseFeature, FeatureMode } from '@beanpool/core';
import { useIdentity } from '../app/IdentityContext';
import { useNodeProfile } from './use-node-profile';
import { effectiveFeatures, readNodeProfile, showcaseMode, type NodeFeatures } from './node-profile';
import { signedGet } from './node-post';
import type { BeanPoolIdentity } from './identity';

/** How long one account's answer is used before it is asked again, as the node's own (an hour). */
const READER_FRESH_MS = 60 * 60 * 1000;
const READER_ASK_MS = 10_000;
const cache = new Map<string, { features: NodeFeatures; at: number }>();
const cacheKey = (url: string, publicKey: string) => `${url.trim().replace(/\/+$/, '').toLowerCase()}|${publicKey}`;

/** The account's own features from `GET /api/community/me`, or null when the node doesn't say or can't be asked. */
export async function askReaderFeatures(url: string, identity: BeanPoolIdentity, fetchTimeoutMs = READER_ASK_MS): Promise<NodeFeatures | null> {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), fetchTimeoutMs);
    try {
        const res = await signedGet(url, '/api/community/me', identity, stop.signal);
        if (!res.ok) return null;
        const body = (await res.json().catch(() => null)) as { features?: unknown } | null;
        if (!body?.features || typeof body.features !== 'object') return null;
        return readNodeProfile({ features: body.features })?.features ?? null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

export interface ReaderFeatures {
    /** The node's set (null until known: every reader treats that as a local community). */
    node: NodeFeatures | null;
    /** This account's own, when the node said. */
    reader: NodeFeatures | null;
    /** The two together: what this reader may do here. */
    effective: NodeFeatures | null;
}

export function useReaderFeatures(): ReaderFeatures {
    const profile = useNodeProfile();
    const { identity } = useIdentity();
    const [reader, setReader] = useState<NodeFeatures | null>(null);
    useFocusEffect(
        React.useCallback(() => {
            let cancelled = false;
            (async () => {
                const url = await AsyncStorage.getItem('beanpool_anchor_url').catch(() => null);
                if (cancelled) return;
                if (!url || !identity?.publicKey || !identity.privateKey) { setReader(null); return; }
                const key = cacheKey(url, identity.publicKey);
                const known = cache.get(key);
                // Only this node's and this account's answer: never one from the node or account before a switch.
                setReader(known?.features ?? null);
                if (known && Date.now() - known.at < READER_FRESH_MS) return;
                const asked = await askReaderFeatures(url, identity as BeanPoolIdentity);
                if (asked) cache.set(key, { features: asked, at: Date.now() });
                if (!cancelled && asked) setReader(asked);
            })();
            return () => { cancelled = true; };
        }, [identity?.publicKey]),
    );
    const node = profile?.features ?? null;
    // One object per change, so a screen's memo that reads it doesn't recompute on every draw.
    const effective = useMemo(() => (node ? effectiveFeatures(node, reader) : null), [node, reader]);
    return { node, reader, effective };
}

/** One feature's mode for this reader: live, read-only, preview or hidden. */
export function useShowcaseMode(feature: ShowcaseFeature): FeatureMode {
    const { node, reader } = useReaderFeatures();
    return showcaseMode(feature, node, reader);
}
