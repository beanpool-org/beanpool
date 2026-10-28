/**
 * One effective feature set per reader (DESIGN-global-showcase-fable.md §4, Marty's pick 6): what `features` says on
 * GET /api/community/me and GET /api/home. Today every reader's is the node's own (GET /api/community/info's), so
 * nothing changes for any app; when BeanID switches a feature on for a verified member, it is narrowed or widened
 * here, and both answers, and later the guards, follow from this one place.
 */
import { getNodeFeatures, type NodeFeatures } from './node-profile.js';
import { getDoor, type Door } from './door.js';
import { db } from '../db/db.js';
import { confirmationDialOn, knownFloor, isNodeMember } from '@beanpool/engine';

export type ReaderFeatures = NodeFeatures & { door: Door };

/** The reader's effective features: what `features` says on GET /api/community/me and GET /api/home. */
export function featuresFor(actor: string | null | undefined): ReaderFeatures {
    const nodeFeatures = getNodeFeatures();
    const res: ReaderFeatures = { ...nodeFeatures, door: getDoor() };
    if (actor && isNodeMember(db, actor) && nodeFeatures.beans && confirmationDialOn(db)) {
        res.knownFloor = knownFloor(db);
    }
    return res;
}
