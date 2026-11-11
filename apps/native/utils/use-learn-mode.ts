/**
 * How Learn shows to this reader (DESIGN-local-knowledge-fable.md §2.9 as amended): `live` where the node's `knowledge` switch
 * is on (a local community), `preview` on the worldwide community when it shows previews (Learn from Example Valley's three
 * sample pages, every action opening the sheet that leads to a local community), otherwise `hidden`. A node that says nothing
 * is off, not on (@beanpool/core knowledgeFeatureMode).
 */
import { knowledgeFeatureMode, type FeatureMode } from '@beanpool/core';
import { useReaderFeatures } from './use-reader-features';

/** `undefined` until the phone has read the community's profile, so a screen never draws Learn before it knows. */
export function useLearnMode(): FeatureMode | undefined {
    const features = useReaderFeatures();
    if (!features.known) return undefined;
    type Set = Record<string, unknown> | null;
    return knowledgeFeatureMode(features.node as unknown as Set, features.reader as unknown as Set);
}
