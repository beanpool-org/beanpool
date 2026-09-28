import { readFileSync } from 'node:fs';

/**
 * Memory hygiene for the keyholder (host design §5.1 item 6). None of it stops a host that reads the machine's memory;
 * it stops the working keys leaking out of the keyholder's memory to somewhere they would outlive the process: a core
 * file, swap, a crash kernel's dump, a debugger or an inspector.
 *
 * What plain Node can and can't do, said plainly:
 *
 * - **mlockall**: Node has no call for it, and the vault ships no native module (one more thing to audit next to the
 *   keys). So memory is NOT locked; it is kept off disk by the image having no swap at all (below), which is the
 *   property mlockall exists to give. {@link MemoryHygiene.mlock} says `unavailable` rather than pretending.
 * - **Core dumps**: the soft RLIMIT_CORE is inherited from whoever starts the keyholder, so V3's systemd unit sets
 *   `LimitCORE=0`. On Linux the keyholder reads its own limit and refuses to start when a core file is possible.
 * - **Inspector and heap snapshots**: refused at start (`--inspect*`, `--heapsnapshot*`, `--heap-prof`,
 *   `--abort-on-uncaught-exception`, in argv or NODE_OPTIONS).
 *
 * What V3's image must provide, and the keyholder reports (never enforces, since it can't change them):
 * - no swap partition or swap file (`/proc/swaps` empty);
 * - no crash kernel loaded (kdump: `/sys/kernel/kexec_crash_loaded` = 0) and no hibernation;
 * - `kernel.yama.ptrace_scope` = 3 (no ptrace at all), and `kernel.core_pattern` not piped to a collector that
 *   keeps cores (moot with LimitCORE=0, belt and braces);
 * - the keyholder under its own user, its socket and state directory readable by that user and the API's only.
 */

export interface MemoryHygiene {
    mlock: 'unavailable';
    coreDumps: 'off' | 'on' | 'unknown';
    swap: 'none' | 'present' | 'unknown';
    kdump: 'off' | 'on' | 'unknown';
    ptraceScope: number | null;
    debugFlags: string[];
}

function readText(path: string): string | null {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return null;
    }
}

const DEBUG_FLAG_RE = /^--(inspect|inspect-brk|inspect-port|inspect-publish-uid|heapsnapshot|heap-prof|cpu-prof|abort-on-uncaught-exception)/;

/** What this process's memory could leak to. Reads only; Linux answers, other systems mostly say `unknown`. */
export function checkMemoryHygiene(): MemoryHygiene {
    const limits = readText('/proc/self/limits');
    let coreDumps: MemoryHygiene['coreDumps'] = 'unknown';
    if (limits) {
        const line = limits.split('\n').find(l => l.startsWith('Max core file size'));
        const soft = line?.replace('Max core file size', '').trim().split(/\s+/)[0];
        if (soft !== undefined) coreDumps = soft === '0' ? 'off' : 'on';
    }
    const swaps = readText('/proc/swaps');
    const swap: MemoryHygiene['swap'] = swaps === null ? 'unknown' : swaps.trim().split('\n').length > 1 ? 'present' : 'none';
    const crash = readText('/sys/kernel/kexec_crash_loaded');
    const kdump: MemoryHygiene['kdump'] = crash === null ? 'unknown' : crash.trim() === '0' ? 'off' : 'on';
    const scope = readText('/proc/sys/kernel/yama/ptrace_scope');
    const ptraceScope = scope === null || !/^\d+$/.test(scope.trim()) ? null : Number(scope.trim());
    const args = [...process.execArgv, ...String(process.env.NODE_OPTIONS ?? '').split(/\s+/)];
    const debugFlags = args.filter(a => DEBUG_FLAG_RE.test(a));
    return { mlock: 'unavailable', coreDumps, swap, kdump, ptraceScope, debugFlags };
}

/**
 * Why the keyholder must not start here, or null. On Linux (the vault's image) a possible core file is a refusal; a
 * debugger flag is a refusal everywhere. Swap, kdump and ptrace are the image's to fix and are reported, not refused,
 * so a misbuilt image still opens and says what is wrong in `/v1/report`.
 */
export function hygieneRefusal(h: MemoryHygiene, platform: NodeJS.Platform = process.platform): string | null {
    if (h.debugFlags.length) return `the keyholder does not run with ${h.debugFlags.join(' ')}: they expose its memory`;
    if (platform === 'linux' && h.coreDumps !== 'off') {
        return 'core dumps are possible (RLIMIT_CORE is not 0): start the keyholder with LimitCORE=0';
    }
    return null;
}
