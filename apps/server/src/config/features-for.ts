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

export type ReaderFeatures = NodeFeatures & { door: Door };

/** The reader's effective features: what `features` says on GET /api/community/me and GET /api/home. */
export function featuresFor(actor: string | null | undefined): ReaderFeatures {
    const nodeFeatures = getNodeFeatures();
    const res: ReaderFeatures = { ...nodeFeatures, door: getDoor() };
    if (actor && nodeFeatures.beans && readsAsMember(db, actor) && confirmationDialOn(db)) {
        res.knownFloor = knownFloor(db);
        const { debtLinePct, quietDays } = healthSettings();
        res.debtLinePct = debtLinePct;
        res.quietDays = quietDays;
    }
    return res;
}

/**
 * Who decides a removal here (config/removal-decider.ts), for a reader who reads as a member, else undefined: "How this
 * community works" says it on the phone and the web (core removalDeciderLine, slice J3). GET /api/community/me and
 * GET /api/home say it as `removalDecider` BESIDE `features`, never in them: `features` is the node's own set, key for key,
 * for every reader, but for a member's known floor and its two lines (W1, S5; test-node-profile holds it to exactly that),
 * and a visitor gets nothing new from the community's settings
 * (DESIGN-community-shape-settings-fable.md §4.3), so the rule is a member's fact, as `probation` and `area` are. The rule,
 * never how many could serve today: that number would tell roughly how big the community is.
 */
export function removalDeciderFor(actor: string | null | undefined): RemovalDecider | undefined {
    return actor && readsAsMember(db, actor) ? removalDecider() : undefined;
}
