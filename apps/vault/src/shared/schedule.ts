/**
 * The monthly planned restart (key vault design §3 and D3): the first Sunday of every month, at 09:00 UTC (19:00 in
 * eastern Australia, 11:00 in the Netherlands and Germany in summer). It installs a new image if one is waiting and
 * picks up kernel and C library fixes; the vault then stays locked until two custodians unlock it.
 *
 * The image's `vault-monthly-restart.timer` says the same in systemd's words ({@link MONTHLY_RESTART_ON_CALENDAR});
 * a test keeps the two in step. `/v1/report` announces the next one (`nextRestart`).
 */

export const MONTHLY_RESTART_HOUR_UTC = 9;
export const MONTHLY_RESTART_ON_CALENDAR = 'Sun *-*-01..07 09:00:00 UTC';

/** The first planned restart at or after `now`. */
export function nextMonthlyRestart(now: number): number {
    const d = new Date(now);
    for (let m = 0; m < 3; m++) {
        const year = d.getUTCFullYear();
        const month = d.getUTCMonth() + m;
        for (let day = 1; day <= 7; day++) {
            const t = Date.UTC(year, month, day, MONTHLY_RESTART_HOUR_UTC, 0, 0);
            if (new Date(t).getUTCDay() === 0 && t >= now) return t;
        }
    }
    throw new Error('unreachable: every month has a first Sunday');
}
