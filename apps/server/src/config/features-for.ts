/**
 * One effective feature set per reader (DESIGN-global-showcase-fable.md §4, Marty's pick 6): what `features` says on
 * GET /api/community/me and GET /api/home. Today every reader's is the node's own (GET /api/community/info's), so
 * nothing changes for any app; when BeanID switches a feature on for a verified member, it is narrowed or widened
 * here, and both answers, and later the guards, follow from this one place.
 */
import { getNodeFeatures, type NodeFeatures } from './node-profile.js';
import { getDoor, type Door } from './door.js';

export type ReaderFeatures = NodeFeatures & { door: Door };

/** The reader's effective features: the node's today, whoever reads. `actor` is the verified signer, or none. */
export function featuresFor(actor: string | null | undefined): ReaderFeatures {
    void actor;
    return { ...getNodeFeatures(), door: getDoor() };
}
