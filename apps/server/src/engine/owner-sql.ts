/**
 * The SQL for "is this an owner?" that the shell's claim commands share with the server (claim-command.ts readNodeView,
 * claim-shell-owner.ts): they open the database themselves, so nothing here imports it.
 */

/**
 * A member (`m`) whose key waits on a re-key code (engine/member-wizards.ts issueRekeyCode): the code made them
 * 'suspended' and holds their key ('rekey_pending', and an expired code's hold, kept until a new code replaces it), and
 * their node_roles row stays, to move to the new key. An owner like that is still an owner: nobody suspended them, their
 * key acts for nothing meanwhile (NODE_ROLE_ACTS), and they are back the moment the new key is bound. A report's
 * suspension takes the role away, and an admin's holds it aside, so neither leaves a row this reads.
 */
export const KEY_HELD_FOR_REKEY = "m.status = 'suspended' AND EXISTS (SELECT 1 FROM invalidated_keys ik "
    + "WHERE ik.public_key = m.public_key AND ik.reason = 'rekey_pending' AND ik.rekeyed_to IS NULL)";

/**
 * Whether this node has an owner at all (engine/node-roles.ts nodeHasOwner): an active member's owner row, an owner whose
 * key waits on a re-key code (KEY_HELD_FOR_REKEY), or an owner role a suspension holds aside. One row, or none.
 */
export const NODE_HAS_OWNER_SQL = `SELECT 1 FROM node_roles nr JOIN members m ON nr.member_pubkey = m.public_key
    WHERE nr.role = 'owner' AND (m.status = 'active' OR (${KEY_HELD_FOR_REKEY}))
    UNION ALL SELECT 1 FROM suspended_node_roles WHERE role = 'owner' LIMIT 1`;
