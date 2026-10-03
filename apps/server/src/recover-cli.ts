/**
 * The `beanpool` command in the node's container (bin/beanpool). One subcommand:
 *
 *   beanpool recover --key <member public key | @callsign>
 *
 * Makes that member an owner, prints their break-glass code once, and tells the community (recover-command.ts).
 */
import { recoverOwner } from './recover-command.js';

const USAGE = `Usage: beanpool recover --key <member public key | @callsign>

Makes a member of this community an owner, when no owner can sign in any more.
It changes nothing else: the community's settings, money and members stay as they are.
The community is told in a critical announcement, and the node's log records it.

The member must have joined first.`;

const [sub, ...rest] = process.argv.slice(2);
if (sub !== 'recover') {
    console.error(USAGE);
    process.exit(2);
}
const at = rest.indexOf('--key');
const who = at >= 0 ? rest[at + 1] : undefined;
if (!who) {
    console.error(USAGE);
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
