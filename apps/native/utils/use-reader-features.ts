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
import { useNodeProfileState } from './use-node-profile';
import { effectiveFeatures, readNodeProfile, showcaseMode, type NodeFeatures } from './node-profile';
import { signedGet } from './node-post';
import type { BeanPoolIdentity } from './identity';

/** How long one account's answer is used before it is asked again, as the node's own (an hour). */
const READER_FRESH_MS = 60 * 60 * 1000;
/** A refusal (a visitor's 403) or no answer at all is asked again sooner, but never on every focus. */
const READER_RETRY_MS = 10 * 60 * 1000;
const READER_ASK_MS = 10_000;
/**
 * Every answer is kept, a null one too: an older node's 200 without `features` is as settled as a W1 node's, and six
 * screens read this on every focus, so an unkept null was a signed ask per focus (review of #1852, finding 1).
 */
const cache = new Map<string, { features: NodeFeatures | null; at: number; freshMs: number }>();
/** One ask in flight per node and account: screens that come into view together wait for the same answer. */
const asking = new Map<string, Promise<NodeFeatures | null>>();
const cacheKey = (url: string, publicKey: string) => `${url.trim().replace(/\/+$/, '').toLowerCase()}|${publicKey}`;

async function askReader(url: string, identity: BeanPoolIdentity, fetchTimeoutMs: number): Promise<{ features: NodeFeatures | null; freshMs: number }> {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), fetchTimeoutMs);
    try {
        const res = await signedGet(url, '/api/community/me', identity, stop.signal);
        if (!res.ok) return { features: null, freshMs: READER_RETRY_MS };
        const body = (await res.json().catch(() => null)) as { features?: unknown } | null;
        if (!body?.features || typeof body.features !== 'object') return { features: null, freshMs: READER_FRESH_MS };
        return { features: readNodeProfile({ features: body.features })?.features ?? null, freshMs: READER_FRESH_MS };
    } catch {
        return { features: null, freshMs: READER_RETRY_MS };
    } finally {
        clearTimeout(timer);
    }
}

/** The account's own features from `GET /api/community/me`, or null when the node doesn't say or can't be asked. */
export async function askReaderFeatures(url: string, identity: BeanPoolIdentity, fetchTimeoutMs = READER_ASK_MS): Promise<NodeFeatures | null> {
    return (await askReader(url, identity, fetchTimeoutMs)).features;
}

/** This account's answer from the node, asked once however many screens ask at the same moment, and kept. */
function readerFeaturesFor(key: string, url: string, identity: BeanPoolIdentity): Promise<NodeFeatures | null> {
    const inFlight = asking.get(key);
    if (inFlight) return inFlight;
    const ask = askReader(url, identity, READER_ASK_MS)
        .then((answer) => {
            cache.set(key, { features: answer.features, at: Date.now(), freshMs: answer.freshMs });
            return answer.features;
        })
        .finally(() => { asking.delete(key); });
    asking.set(key, ask);
    return ask;
}

export interface ReaderFeatures {
    /** The node's set (null until known: every reader treats that as a local community). */
    node: NodeFeatures | null;
    /** This account's own, when the node said. */
    reader: NodeFeatures | null;
    /** The two together: what this reader may do here. */
    effective: NodeFeatures | null;
    /** Whether this phone's own copy of the node's profile has been read (useNodeProfileState's `copyRead`). */
    known: boolean;
}

export function useReaderFeatures(): ReaderFeatures {
    const { profile, copyRead } = useNodeProfileState();
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
                if (known && Date.now() - known.at < known.freshMs) return;
                const asked = await readerFeaturesFor(key, url, identity as BeanPoolIdentity);
                if (!cancelled && asked) setReader(asked);
            })();
            return () => { cancelled = true; };
        }, [identity?.publicKey]),
    );
    const node = profile?.features ?? null;
    // One object per change, so a screen's memo that reads it doesn't recompute on every draw.
    const effective = useMemo(() => (node ? effectiveFeatures(node, reader) : null), [node, reader]);
    return { node, reader, effective, known: copyRead };
}

/** One feature's mode for this reader: live, read-only, preview or hidden. */
export function useShowcaseMode(feature: ShowcaseFeature): FeatureMode {
    const { node, reader } = useReaderFeatures();
    return showcaseMode(feature, node, reader);
}

/**
 * useShowcaseMode, but `undefined` until this phone's own copy of the node's profile has been read (a moment, no network).
 * For a screen that asks the node for a feature's data as it comes into view: it asks nothing until the mode is known,
 * so the worldwide community's Ledger, in preview, never asks for the reader's own ledger first.
 */
export function useShowcaseModeOnceKnown(feature: ShowcaseFeature): FeatureMode | undefined {
    const { node, reader, known } = useReaderFeatures();
    return known ? showcaseMode(feature, node, reader) : undefined;
}
