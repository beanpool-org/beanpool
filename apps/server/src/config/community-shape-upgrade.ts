/**
 * How this community works S3: the one translation an update makes (scratch/fable-design/DESIGN-community-shape-settings-fable.md
 * §3.2, §3.3; Marty's answers to Q3, Q4 and Q8, 23 Oct). S3 took away two second ways of saying what the community
 * already has a setting for, and two switches nothing in the product wants:
 *
 *   - the gateway's `invites` switch (local-config.json gateway.features), a blunter copy of the `invites` profile switch:
 *     off, every invite and knock route answered 503. Carried over to Paused (nodeProfile.invites = false), which refuses
 *     both. Where the open door is set too (the global kind, an operator's nodeProfile.openJoin), invites off there read
 *     as that door, which no owner changes (config/community-shape-write.ts): the owners are told whoever runs the server
 *     turns invites back on. Where the private preview is on, owners and admins invite all the same (the preview's own
 *     rule): the old switch stopped their invites too, and nothing does that now, so the owners are told.
 *   - the gateway's `messaging` and `marketplace` switches. Nothing takes their place (Q4): a community without chat or
 *     a Market has no working deals. Off, the Market answered 503 (/api/marketplace): it works again, a deliberate change
 *     of behaviour. The messaging switch matched /api/messaging, which no route is under (members' messages are
 *     /api/messages), so it never stopped anything: messages worked all along, and still do. The owners are told both,
 *     in those words, since an owner who switched one off thinks it is off.
 *   - the gateway's `federation` switch: federation's HTTP routes answer only where ENABLE_PEER_CONNECTORS is on now
 *     (https-server.ts, Q3). With it off they answered nothing either way; with it on they answer again, and the owners
 *     are told.
 *   - the directory update schedule's 0, Never: Listed (`publishToDirectory`) off, and the schedule every 12 hours for
 *     when it is listed again (Q8). Nothing is sent either way.
 *
 * Once: the stores it reads are what it writes, so the next start finds nothing to carry and writes nothing. The
 * profile override and the schedule are written first, in one transaction, then the old switches leave the file: a
 * crash between the two carries the same over again, never loses it. Every carry is a line in the server's log, and
 * one that changes a stored setting or what the community does is one owner alert (`sec.settings`) with all of them.
 *
 * Where it runs: a main server's boot (initStateEngine) and a promotion in place (becomeMainServerInPlace), before
 * anything serves; and the install of a main server's settings kept by a standby (config/community-settings.ts), which a
 * main server from before S3 may send with these in it. A standby's own stores are never carried: they are replaced at a
 * take-over by its main server's.
 */
import { word } from '@beanpool/core';
import { db } from '../db/db.js';
import { logger } from '../logger.js';
import { getLocalConfig, saveLocalConfig } from './local-config.js';
import { REMOVED_GATEWAY_SWITCHES, type RemovedGatewaySwitch } from './gateway.js';
import { getConfiguredSwitches, setSwitchOverride } from './node-profile.js';
import { isPrivatePreview } from './private-preview.js';
import { DEFAULT_DIRECTORY_PUSH_INTERVAL_HOURS, LEGACY_NEVER_INTERVAL } from './community-settings.js';
import { getNodeConfig, updateNodeConfig } from '../state-engine.js';
import { ENABLE_PEER_CONNECTORS } from '../connector-manager.js';
import { noteSecurityEvent } from '../services/security-signal.js';

/** What the owners are told, one whole sentence per carry: the server's own words, never a member's. */
export const UPGRADE_WORDS = {
    invitesPaused: word("This server's update carried an old setting over: the Gateway switch Cryptographic Invites was off, so new members are paused under How this community works. Nobody new joins until an owner changes it there."),
    invitesOpenDoor: word("This server's update carried an old setting over: the Gateway switch Cryptographic Invites was off, so invites are off here. The open door this server sets is the only way in; whoever runs the server turns invites back on (nodeProfile.invites = true)."),
    invitesAlreadyOff: word("This server's update removed the Gateway switch Cryptographic Invites, which was off: new members were already paused under How this community works."),
    invitesPreview: word('While the private preview is on, owners and admins can invite people again: the old switch stopped their invites too, and nothing does that now.'),
    messaging: word("This server's update removed the Gateway switch P2P Direct Messaging, which was off. It never stopped messages here (it matched none of the routes they use), so members message each other as before."),
    marketplace: word("This server's update removed the Gateway switch Marketplace, which was off: the Market works here again."),
    federation: word("This server's update removed the Gateway switch Multi-Node Federation, which was off: this server's connections to other communities are on (ENABLE_PEER_CONNECTORS), so their routes answer again."),
    neverUnlisted: word("This server's update carried an old setting over: the directory update schedule was Never, so this community is not Listed under How this community works, and the schedule is every 12 hours for when it is listed again."),
    neverSchedule: word("This server's update carried an old setting over: the directory update schedule was Never, and is every 12 hours now. This community stays off the directory: Listed is off under How this community works."),
} as const;

export interface ShapeUpgrade {
    /** What was carried over, a few words each (the server's log, the take-over's step); empty when nothing was. */
    carried: string[];
    /** The owner alert's sentences: empty when nothing changed that an owner set or the community does. */
    told: string[];
}

/** The old gateway switches local-config.json still holds, each as stored. */
function storedOldSwitches(): Partial<Record<RemovedGatewaySwitch, unknown>> {
    const features = getLocalConfig().gateway?.features as Record<string, unknown> | undefined;
    if (!features || typeof features !== 'object') return {};
    const out: Partial<Record<RemovedGatewaySwitch, unknown>> = {};
    for (const k of Object.keys(REMOVED_GATEWAY_SWITCHES) as RemovedGatewaySwitch[]) {
        if (Object.prototype.hasOwnProperty.call(features, k)) out[k] = features[k];
    }
    return out;
}

/**
 * Carry over what this server's stores hold from before S3 (the header), once. Throws only where a store can't be
 * written; the boot's caller logs that and goes on (upgradeLegacyShapeAtBoot), and the next start carries it again.
 */
export function upgradeLegacyShape(): ShapeUpgrade {
    const old = storedOldSwitches();
    const never = getNodeConfig().directoryPushIntervalHours === LEGACY_NEVER_INTERVAL;
    const carried: string[] = [];
    const told: string[] = [];
    if (Object.keys(old).length === 0 && !never) return { carried, told };

    // The community's stores first, both or neither.
    const cfg = getConfiguredSwitches();
    db.transaction(() => {
        if (old.invites === false && cfg.invites) setSwitchOverride('invites', false);
        if (never) {
            if (cfg.publishToDirectory) setSwitchOverride('publishToDirectory', false);
            updateNodeConfig({ directoryPushIntervalHours: DEFAULT_DIRECTORY_PUSH_INTERVAL_HOURS });
        }
    })();

    if (old.invites === false) {
        // The private preview takes owners' and admins' invites whatever invites are set to (node-profile.ts
        // lockToPrivatePreview); the old switch stopped those too, so under it they come back, paused or not before.
        const preview = isPrivatePreview();
        const previewLine = preview ? ' While the private preview is on, owners and admins invite all the same: the old switch stopped their invites too.' : '';
        if (cfg.invites && cfg.openJoin) {
            carried.push('invites off (the Gateway switch Cryptographic Invites was off), the open door set beside them');
            told.push(UPGRADE_WORDS.invitesOpenDoor, ...(preview ? [UPGRADE_WORDS.invitesPreview] : []));
            logger.warn('SYS', "⚙️ The old Gateway switch 'Cryptographic Invites' was off: invites are off now (nodeProfile.invites = false), and the open door this server sets is the only way in. To turn invites back on, set the node_config row nodeProfile.invites = true." + previewLine);
        } else if (cfg.invites) {
            carried.push('invites paused (the Gateway switch Cryptographic Invites was off)');
            told.push(UPGRADE_WORDS.invitesPaused, ...(preview ? [UPGRADE_WORDS.invitesPreview] : []));
            logger.warn('SYS', "⚙️ The old Gateway switch 'Cryptographic Invites' was off: this community is now Paused under How this community works (nodeProfile.invites = false). Nobody new joins until an owner changes it." + previewLine);
        } else if (preview) {
            carried.push('the Gateway switch Cryptographic Invites (off, as invites already were; under the private preview owners and admins invite again)');
            told.push(UPGRADE_WORDS.invitesAlreadyOff, UPGRADE_WORDS.invitesPreview);
            logger.warn('SYS', "⚙️ The old Gateway switch 'Cryptographic Invites' was off, and invites were too." + previewLine);
        } else {
            carried.push('the Gateway switch Cryptographic Invites (off, as invites already were)');
            logger.info('SYS', "⚙️ The old Gateway switch 'Cryptographic Invites' was off, and so were invites: nothing changes.");
        }
    }
    if (old.marketplace === false) {
        carried.push('the Gateway switch Marketplace (off, removed: the Market works again)');
        told.push(UPGRADE_WORDS.marketplace);
        logger.warn('SYS', "⚠️ The old Gateway switch 'Marketplace' was off and no longer exists: the Market works here again. Nothing in BeanPool runs a community without a Market.");
    }
    if (old.messaging === false) {
        carried.push('the Gateway switch P2P Direct Messaging (off, removed: it never stopped messages)');
        told.push(UPGRADE_WORDS.messaging);
        logger.warn('SYS', "⚠️ The old Gateway switch 'P2P Direct Messaging' was off and no longer exists. It matched /api/messaging, which no route is under (messages are /api/messages), so messages worked all along and still do.");
    }
    if (old.federation === false) {
        if (ENABLE_PEER_CONNECTORS) {
            carried.push('the Gateway switch Multi-Node Federation (off, removed: ENABLE_PEER_CONNECTORS is on, so its routes answer)');
            told.push(UPGRADE_WORDS.federation);
            logger.warn('SYS', "⚠️ The old Gateway switch 'Multi-Node Federation' was off and no longer exists: ENABLE_PEER_CONNECTORS is on, so the federation routes answer again. To keep them off, unset ENABLE_PEER_CONNECTORS.");
        } else {
            carried.push('the Gateway switch Multi-Node Federation (off, as ENABLE_PEER_CONNECTORS is)');
            logger.info('SYS', "⚙️ The old Gateway switch 'Multi-Node Federation' was off and no longer exists: ENABLE_PEER_CONNECTORS is off, so the federation routes stay off.");
        }
    }
    const dropped = (Object.keys(old) as RemovedGatewaySwitch[]).filter((k) => old[k] !== false);
    if (dropped.length) {
        carried.push(`the Gateway switches ${dropped.map((k) => REMOVED_GATEWAY_SWITCHES[k]).join(', ')} (on, removed)`);
        logger.info('SYS', `⚙️ The old Gateway switches ${dropped.map((k) => `'${REMOVED_GATEWAY_SWITCHES[k]}'`).join(', ')} were on and no longer exist: nothing changes.`);
    }
    if (never) {
        carried.push(cfg.publishToDirectory ? 'not Listed (the directory update schedule was Never)' : 'the directory update schedule (Never, now every 12 hours)');
        told.push(cfg.publishToDirectory ? UPGRADE_WORDS.neverUnlisted : UPGRADE_WORDS.neverSchedule);
        logger.warn('SYS', cfg.publishToDirectory
            ? '📴 The directory update schedule was Never: this community is now not Listed under How this community works (nodeProfile.publishToDirectory = false), and the schedule is every 12 hours for when it is listed again.'
            : '📴 The directory update schedule was Never, and is every 12 hours now. Listed was already off, so nothing is sent.');
    }

    // Then the old switches leave the file, so the next start finds none.
    if (Object.keys(old).length > 0) {
        const config = getLocalConfig();
        const features = { ...(config.gateway?.features as Record<string, unknown> | undefined) };
        for (const k of Object.keys(old)) delete features[k];
        config.gateway = { ...config.gateway!, features: features as { servePwa: boolean } };
        saveLocalConfig(config);
        if (Object.keys(storedOldSwitches()).length > 0) {
            logger.error('SYS', 'Could not remove the old Gateway switches from local-config.json: they are carried over again at the next start.');
        }
    }

    if (told.length > 0) noteSecurityEvent({ key: 'sec.settings', detail: told.join(' ') });
    return { carried, told };
}

/** At a main server's boot (initStateEngine) and a promotion in place: never on a standby, and never throws. */
export function upgradeLegacyShapeAtBoot(role: 'primary' | 'backup'): void {
    if (role !== 'primary') return;
    try {
        const done = upgradeLegacyShape();
        if (done.carried.length > 0) logger.info('SYS', `[Settings] Carried over from before How this community works: ${done.carried.join('; ')}.`);
    } catch (e: any) {
        logger.error('SYS', `[Settings] Could not carry over the old settings (the Gateway switches, the directory schedule's Never): ${e?.message || e}. They are tried again at the next start.`);
    }
}
