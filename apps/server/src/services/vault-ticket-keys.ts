/**
 * The key vault's ticket keys this node's open door accepts (key vault V5; scratch/global-node/DESIGN-v5-global-door-
 * vault-fable.md §1.1). A phone built with a key vault binds its door sign-in to a vault deposit ticket instead of the
 * door's own nonce, so one sign-in both joins and deposits its copy at the vault (routes/open-join.ts has the check).
 * The door checks the ticket offline with the vault's PUBLIC Ed25519 ticket keys; it never talks to the vault.
 *
 *   BEANPOOL_VAULT_TICKET_KEYS=<hex>[,<hex>]
 *
 * Newest first, each 64 lower-case hex characters, at most two (the vault has room for two ticket keys while one
 * replaces the other). The same string as the app build's EXPO_PUBLIC_BEANPOOL_VAULT_TICKET_KEYS, from the vault's
 * genesis. Empty, unset or malformed: no keys, and the door takes no tickets. Every join then uses the door's own nonce,
 * as it always has, and its nonce answer says `vault: null`, so a phone knows before it opens a sign-in sheet.
 *
 * ## From the operator's hand only
 *
 * - From the environment, read at every request like NODE_PROFILE: cheap, and a test can change it in place.
 * - Never from the network: not from the vault's health or report answer, which offers its ticket key. A server at the
 *   vault's address could hand the door a key of its own; a pin comes from the operator, as it does on the phone.
 * - Not a key file and not a row: the keys are public and open nothing, so they are not in node_config, not in a
 *   replication payload, a backup or the take-over bundle (takeover-envelope.ts BUNDLED_FILES). A standby gets the same
 *   line in its own .env. A take-over does not compare it: a promoted server without the line runs the door with its
 *   own nonce, and phones join that way.
 * - Nobody else needs it. A node that is not BeanPool's own global leaves it empty: its door works exactly as before,
 *   with its own nonce, and nothing about it needs BeanPool's vault or any server of ours.
 */
import { isVaultKeyHex } from '@beanpool/core';
import { getProfileSwitches } from '../config/node-profile.js';

/** The variable, as docker-compose.yml passes it through from .env. */
export const VAULT_TICKET_KEYS_ENV = 'BEANPOOL_VAULT_TICKET_KEYS';

/** The vault keeps at most two ticket keys: the one that signs, and the one it replaces while builds still pin it. */
export const MAX_VAULT_TICKET_KEYS = 2;

export type VaultTicketKeysProblem = 'malformed' | 'too-many';

/** The keys the variable names, newest first, or none with why: unset/empty has no problem, just no keys. */
export function readVaultTicketKeys(env: NodeJS.ProcessEnv = process.env): { keys: string[]; problem: VaultTicketKeysProblem | null } {
    const list = (env[VAULT_TICKET_KEYS_ENV] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!list.length) return { keys: [], problem: null };
    if (!list.every(isVaultKeyHex)) return { keys: [], problem: 'malformed' };
    if (list.length > MAX_VAULT_TICKET_KEYS) return { keys: [], problem: 'too-many' };
    return { keys: list, problem: null };
}

/** The ticket keys the door accepts now, newest first; empty when it takes no tickets. */
export function vaultTicketKeys(env: NodeJS.ProcessEnv = process.env): string[] {
    return readVaultTicketKeys(env).keys;
}

const short = (key: string) => `${key.slice(0, 8)}…`;

/**
 * What the boot log says about the door's vault keys, in one line, or null when there is nothing to say (a door that is
 * shut, with no keys set).
 */
export function vaultTicketKeysLine(doorOpen: boolean, env: NodeJS.ProcessEnv = process.env): string | null {
    const { keys, problem } = readVaultTicketKeys(env);
    if (problem) {
        const what = problem === 'too-many'
            ? `holds more than ${MAX_VAULT_TICKET_KEYS} keys (a key vault has at most ${MAX_VAULT_TICKET_KEYS})`
            : 'is not a comma-separated list of 64-character lower-case hex keys';
        return `⚠️ Open door: ${VAULT_TICKET_KEYS_ENV} ${what}, so the door takes no key vault tickets: every join uses the door's `
            + 'own sign-in check. Copy the value again from the vault\'s genesis, the same as the app build\'s, and restart the server.';
    }
    if (!doorOpen) return keys.length ? `🎟️ ${VAULT_TICKET_KEYS_ENV} is set, but this node's open door is shut, so nothing uses it.` : null;
    if (!keys.length) return `🚪 Open door: no key vault ticket keys (${VAULT_TICKET_KEYS_ENV}), so it takes no vault tickets: every join uses the door's own sign-in check.`;
    return `🎟️ Open door: takes key vault tickets signed by ${keys.length === 1 ? 'one key' : `${keys.length} keys, newest first`}: ${keys.map(short).join(', ')}.`;
}

/** Say once at boot which vault tickets the door takes. Never throws. */
export function announceVaultTicketKeysAtBoot(): void {
    try {
        const line = vaultTicketKeysLine(getProfileSwitches().openJoin);
        if (!line) return;
        if (line.startsWith('⚠️')) console.warn(line); else console.log(line);
    } catch (e) {
        console.warn(`⚠️ Open door: could not read ${VAULT_TICKET_KEYS_ENV}: ${(e as Error)?.message || e}`);
    }
}
