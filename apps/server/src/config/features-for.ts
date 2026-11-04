/**
 * One effective feature set per reader (DESIGN-global-showcase-fable.md §4, Marty's pick 6): what `features` says on
 * GET /api/community/me and GET /api/home. Today every reader's is the node's own (GET /api/community/info's), so
 * nothing changes for any app; when BeanID switches a feature on for a verified member, it is narrowed or widened
 * here, and both answers, and later the guards, follow from this one place.
 */
import { getNodeFeatures, type NodeFeatures } from './node-profile.js';
import { getDoor, type Door } from './door.js';
import { db } from '../db/db.js';
import { confirmationDialOn, knownFloor, readsAsMember } from '@beanpool/engine';
import { healthSettings } from '../engine/community-health.js';
import { removalDecider, type RemovalDecider } from './removal-decider.js';

/**
 * `removalDecider`: who decides a removal here (config/removal-decider.ts), in a member's read only, beside the rule's lines:
 * "How this community works" says it on the phone and the web (core removalDeciderLine, slice J3). The rule, never how
 * many could serve today: that number would tell a visitor roughly how big the community is.
 */
export type ReaderFeatures = NodeFeatures & { door: Door; removalDecider?: RemovalDecider };

/** The reader's effective features: what `features` says on GET /api/community/me and GET /api/home. */
export function featuresFor(actor: string | null | undefined): ReaderFeatures {
    const nodeFeatures = getNodeFeatures();
    const res: ReaderFeatures = { ...nodeFeatures, door: getDoor() };
    const member = !!actor && readsAsMember(db, actor);
    if (member) res.removalDecider = removalDecider();
    if (member && nodeFeatures.beans && confirmationDialOn(db)) {
        res.knownFloor = knownFloor(db);
        const { debtLinePct, quietDays } = healthSettings();
        res.debtLinePct = debtLinePct;
        res.quietDays = quietDays;
    }
    return res;
}
