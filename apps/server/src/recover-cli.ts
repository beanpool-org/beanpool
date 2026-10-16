/**
 * The `beanpool` command in the node's container (bin/beanpool). Five subcommands:
 *
 *   beanpool claim [--name <label> | --address <url> | --no-name] [--direct <url>]   (claim-command.ts)
 *   beanpool claim --key <public key> --callsign <name>                                (claim-shell-owner.ts)
 *   beanpool recover --key <member public key | @callsign>                             (recover-command.ts)
 *   beanpool restore [--code-file F] [--accept-signer <PeerId>] [--with-keys] FILE     (restore-command.ts)
 *   beanpool restore --unlocked FILE.tar.gz
 *   beanpool restore-point list | roll-back NAME                                       (restore-point-command.ts)
 *   beanpool pair [--code-file F] [--follow-new-server]                                (pair-command.ts)
 *
 * claim: the last step of an install, the address and then the one-time code and its QR for the phone. recover: makes
 * a member an owner, prints their break-glass code once, and tells the community. restore and restore-point roll-back:
 * with the node stopped, replace this server with a backup or a restore point, keeping a restore point first. pair: on a
 * standby, pins its main server from the pairing code made there (no route can). There is
 * no command that wipes or deletes (design case 18 D1; Marty, 15 Oct: recipes in the manual only).
 *
 * Exit codes: 0 done, 1 refused (nothing changed), 2 usage.
 */
import util from 'node:util';
import { recoverOwner } from './recover-command.js';
import { CLAIM_USAGE, runClaim } from './claim-command.js';
import { RESTORE_USAGE, runRestore, shown } from './restore-command.js';
import { RESTORE_POINT_USAGE, runRestorePoint } from './restore-point-command.js';
import { PAIR_USAGE, runPair } from './pair-command.js';
import { terminalAsk } from './shell-prompt.js';

const RECOVER_USAGE = `Usage: beanpool recover --key <member public key | @callsign>

Makes a member of this community an owner, when no owner can sign in any more.
It changes nothing else: the community's settings, money and members stay as they are.
The community is told in a critical announcement, and the node's log records it.

The member must have joined first.`;

const USAGE = `${CLAIM_USAGE}\n\n${RECOVER_USAGE}\n\n${RESTORE_USAGE}\n\n${RESTORE_POINT_USAGE}\n\n${PAIR_USAGE}`;

const [sub, ...rest] = process.argv.slice(2);
if (sub === 'claim') {
    runClaim(rest).then(code => process.exit(code), (e) => {
        console.error(`Nothing was changed. ${e?.message || e}`);
        process.exit(1);
    });
} else if (sub === 'restore' || sub === 'restore-point' || sub === 'pair') {
    // Everything this prints reaches the owner's terminal, and some of it is a backup file's own text: the restore's log
    // lines name what the archive held (a trigger, a photo's key, a bucket). No control character of it reaches the
    // terminal, and a log line stays one line (#2017 confirmation review B2). The commands' own lines keep their breaks.
    const lines = (stream: NodeJS.WriteStream) => (l: string) => { stream.write(`${l.split('\n').map((x) => shown(x, null)).join('\n')}\n`); };
    for (const [name, stream] of [['log', process.stdout], ['info', process.stdout], ['debug', process.stdout],
        ['warn', process.stderr], ['error', process.stderr]] as const) {
        console[name] = (...a: unknown[]) => { stream.write(`${shown(util.format(...a), null)}\n`); };
    }
    const prompt = terminalAsk();
    const io = { ask: prompt.ask, out: lines(process.stdout), err: lines(process.stderr) };
    (sub === 'restore' ? runRestore(rest, io) : sub === 'pair' ? runPair(rest, io) : runRestorePoint(rest, io)).then((code) => {
        prompt.close();
        process.exit(code);
    }, (e) => {
        prompt.close();
        console.error(`Nothing was changed. ${e?.message || e}`);
        process.exit(1);
    });
} else if (sub === 'recover') {
    const at = rest.indexOf('--key');
    const who = at >= 0 ? rest[at + 1] : undefined;
    if (!who) {
        console.error(RECOVER_USAGE);
        process.exit(2);
    }
    const result = recoverOwner(who);
    if (!result.ok) {
        console.error(`Nothing was changed. ${result.reason}`);
        process.exit(1);
    }
    console.log(result.alreadyOwner
        ? `@${result.callsign} was already an owner. They have a new break-glass code; any code they had before no longer works.`
        : `@${result.callsign} is now an owner of this community.`);
    console.log(`\nTheir break-glass code (shown once, give it only to them): ${result.breakGlassCode}`);
    console.log('\nThe community will see a notice that an owner was added from the server.');
} else {
    console.error(USAGE);
    process.exit(2);
}
