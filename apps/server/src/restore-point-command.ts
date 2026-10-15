/**
 * `beanpool restore-point` (design case 18 §3.3 and §4, slice S3): the restore points on the server itself.
 *
 *   beanpool restore-point list             each point: name, when, why, size, kept until; read-only, the node may run
 *   beanpool restore-point roll-back NAME   with the node STOPPED: keeps a point of this server as it is, then puts NAME's
 *                                           database, images and per-server files back, and leaves the notice
 *
 * For when the interface is the thing a hostile restore took away: the restored database carries its own owners and
 * admin password, so the real owner may no longer sign in. The roll-back is Settings' own (routes/backup.ts rollBackTo):
 * the point is read like any archive, a point of the current state is kept first (so a roll-back can be rolled back),
 * and everyone sees the notice at the next start. Nothing here removes a point or changes how long one is kept.
 *
 * `list` reads the folder only (services/restore-point-names.ts opens no database), so it runs beside a live node.
 *
 * Exit codes: 0 done, 1 refused (nothing was changed), 2 usage.
 */
import { dataDir } from './recover-command.js';
import { listRestorePoints, resolveRestorePoint } from './services/restore-point-names.js';
import { nodeRunningLockStillOurs } from './node-running-lock.js';
import {
    CODE_IN_ARGS, codeInArgs, damagedDatabase, LOCK_LOST, reason, RESTORE_EXIT, stoppedNodeCheck, type ShellIo,
} from './restore-command.js';

export const RESTORE_POINT_USAGE = `Usage: beanpool restore-point list
       beanpool restore-point roll-back NAME

A restore point is this server as it was just before a restore or a roll-back replaced it, kept in data/restore-points.
The newest 5 are kept, none younger than 7 days is removed, none older than 30 days is kept.
roll-back needs the node stopped:
  docker compose stop beanpool-node
  docker compose run --rm beanpool-node beanpool restore-point roll-back NAME
  docker compose up -d`;

function size(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export async function runRestorePoint(args: string[], io: ShellIo, dir = dataDir()): Promise<number> {
    if (codeInArgs(args)) {
        io.err(CODE_IN_ARGS);
        return RESTORE_EXIT.usage;
    }
    const [what, ...rest] = args;
    if (what === 'list' && rest.length === 0) {
        const points = listRestorePoints();
        if (points.length === 0) {
            io.out('No restore points. One is kept each time a backup is restored or the server is rolled back.');
            return RESTORE_EXIT.done;
        }
        for (const p of points) {
            io.out(`${p.name}`);
            io.out(`  taken ${p.takenAt.slice(0, 16).replace('T', ' ')} UTC, before a ${p.why}, ${size(p.bytes)}; `
                + `kept until at least ${p.keptAtLeastUntil.slice(0, 10)}, at most ${p.keptAtMostUntil.slice(0, 10)}`);
        }
        return RESTORE_EXIT.done;
    }
    if (what !== 'roll-back' || rest.length !== 1) {
        io.err(RESTORE_POINT_USAGE);
        return RESTORE_EXIT.usage;
    }
    const name = rest[0];
    const refuse = (why: string): number => {
        io.err(why.endsWith('Nothing was changed.') ? why : `${why} Nothing was changed.`);
        return RESTORE_EXIT.refused;
    };
    const pointDir = resolveRestorePoint(name);
    if (!pointDir) return refuse(`There is no restore point ${name}. beanpool restore-point list shows them.`);
    const stopped = stoppedNodeCheck(dir);
    if (stopped) return refuse(stopped);
    const point = listRestorePoints().find((p) => p.name === name)!;
    io.out(`Roll this server back to ${name}, as it was on ${point.takenAt.slice(0, 16).replace('T', ' ')} UTC (before a ${point.why})?`);
    io.out('Everything since then goes: its database, photos and per-server files (keys, password, 2FA) come back. '
        + 'A restore point of this server as it is now is kept first, so this can be undone the same way.');
    const typed = await io.ask('Type yes to roll back: ');
    if ((typed ?? '').trim() !== 'yes') return refuse('You did not type yes.');

    // Only now the node's own modules: they open state.db as the node does at its start, which is safe with it stopped.
    let backup: typeof import('./routes/backup.js');
    let RestorePointError: typeof import('./services/restore-points.js').RestorePointError;
    try {
        backup = await import('./routes/backup.js');
        ({ RestorePointError } = await import('./services/restore-points.js'));
    } catch (e: any) {
        const broken = damagedDatabase(e);
        if (broken) return refuse(broken);
        throw e;
    }
    // Right before anything is replaced: the lock this command took is still its own, so no node has started (B1).
    if (!nodeRunningLockStillOurs(dir)) return refuse(LOCK_LOST);
    const before = new Set(listRestorePoints().map((p) => p.name));
    try {
        const body = await backup.rollBackTo(pointDir, name, null);
        io.out('');
        io.out(`Rolled back to ${name}.`);
        if (Array.isArray(body.movedAside) && body.movedAside.length) {
            io.out(`Files the point did not hold were moved aside, not deleted: ${body.movedAside.join(', ')}.`);
        }
        const kept = (body as any).restorePoint;
        if (kept?.name) {
            io.out(`Restore point ${kept.name} is kept until at least ${String(kept.keptAtLeastUntil).slice(0, 10)}. `
                + `To undo this roll-back: beanpool restore-point roll-back ${kept.name}`);
        }
        io.out('Start the node: docker compose up -d. Everyone sees a notice that the community was rolled back; sign in again.');
        return RESTORE_EXIT.done;
    } catch (e: any) {
        backup.cleanupRestoreTemp();
        if (e instanceof RestorePointError) return refuse(damagedDatabase(e) ?? e.message);
        const taken = listRestorePoints().find((p) => !before.has(p.name));
        if (taken) {
            io.err(`The roll-back stopped part way: ${e?.message || e}. Restore point ${taken.name} kept this server as it was `
                + `just before; to go back to it: beanpool restore-point roll-back ${taken.name}`);
            return RESTORE_EXIT.refused;
        }
        return refuse(`Nothing was rolled back: ${reason(e)}`);
    }
}
