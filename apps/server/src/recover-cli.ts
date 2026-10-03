/**
 * The `beanpool` command in the node's container (bin/beanpool). Two subcommands:
 *
 *   beanpool claim [--name <label> | --address <url> | --no-name] [--direct <url>]   (claim-command.ts)
 *   beanpool claim --key <public key> --callsign <name>                                (claim-shell-owner.ts)
 *   beanpool recover --key <member public key | @callsign>                             (recover-command.ts)
 *
 * claim: the last step of an install, the address and then the one-time code and its QR for the phone. recover: makes
 * a member an owner, prints their break-glass code once, and tells the community. Exit codes: 0 done, 1 refused
 * (nothing changed), 2 usage.
 */
import { recoverOwner } from './recover-command.js';
import { CLAIM_USAGE, runClaim } from './claim-command.js';

const RECOVER_USAGE = `Usage: beanpool recover --key <member public key | @callsign>

Makes a member of this community an owner, when no owner can sign in any more.
It changes nothing else: the community's settings, money and members stay as they are.
The community is told in a critical announcement, and the node's log records it.

The member must have joined first.`;

const USAGE = `${CLAIM_USAGE}\n\n${RECOVER_USAGE}`;

const [sub, ...rest] = process.argv.slice(2);
if (sub === 'claim') {
    runClaim(rest).then(code => process.exit(code), (e) => {
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
