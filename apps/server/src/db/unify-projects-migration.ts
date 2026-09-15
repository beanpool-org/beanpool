import type Database from 'better-sqlite3';

/**
 * Migration: Unify crowdfund projects and Commons proposals into Enterprises.
 * Source: docs/the-commons.md §2.1-2.2, §6 Slice 3, §7 item 7.
 *
 * An enterprise is a row in `members` with `is_treasury = 1`.
 * A project IS an enterprise with purpose, goal_amount, deadline_at, and lifecycle = 'bounded'.
 *
 * This migration:
 * 1. Migrates every existing `projects` row into an enterprise in `members`, preserving its id so
 *    foreign keys (transactions.project_id) and escrow account references remain valid.
 * 2. Assigns the project creator as `lead` keeper in `treasury_operators` and sets `can_operate = 1`.
 * 3. Never deletes source data in this PR: marks `projects.migrated_at` and `projects.enterprise_pubkey`.
 * 4. Migrates every Commons proposal from the `commons_projects` JSON blob in `node_config` into
 *    an enterprise row, marking each proposal `migrated = true` in the blob.
 * 5. Is fully idempotent: re-running against an already-migrated database performs zero duplicate mutations.
 */
export function migrateProjectsAndCommonsToEnterprises(targetDb: Database.Database): {
    migratedProjects: number;
    migratedCommonsProposals: number;
} {
    let migratedProjects = 0;
    let migratedCommonsProposals = 0;

    // Helper: generate a unique callsign if title collides with existing member
    const getUniqueCallsign = (title: string, selfPubkey: string): string => {
        const base = (title || 'Project').trim().slice(0, 40) || 'Project';
        const existing = targetDb.prepare(
            "SELECT public_key FROM members WHERE lower(callsign) = lower(?) AND status NOT IN ('migrated', 'pruned') AND public_key != ?"
        ).get(base, selfPubkey) as any;
        if (!existing) return base;
        const suffix = selfPubkey.slice(0, 6);
        return `${base.slice(0, 33)}-${suffix}`;
    };

    // 1. Migrate projects table
    try {
        const tableCheck = targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'").get();
        if (tableCheck) {
            const projects = targetDb.prepare(
                "SELECT * FROM projects WHERE migrated_at IS NULL"
            ).all() as any[];

            for (const p of projects) {
                const enterprisePubkey = p.id;
                const callsign = getUniqueCallsign(p.title, enterprisePubkey);
                let photoUrl = '';
                if (p.photos) {
                    try {
                        const parsed = JSON.parse(p.photos);
                        if (Array.isArray(parsed) && parsed.length > 0) photoUrl = parsed[0];
                    } catch { }
                }
                const desc = p.description || '';
                const purpose = desc || p.title;
                const goal = p.goal_amount != null ? Number(p.goal_amount) : null;
                const deadline = p.deadline_at || null;
                const status = (p.status || 'ACTIVE').toLowerCase();
                const createdAt = p.created_at || new Date().toISOString();
                const updatedAt = p.updated_at || createdAt;

                targetDb.transaction(() => {
                    const existingMember = targetDb.prepare(
                        "SELECT public_key, is_treasury FROM members WHERE public_key = ?"
                    ).get(enterprisePubkey) as any;

                    if (!existingMember) {
                        targetDb.prepare(`
                            INSERT INTO members (
                                public_key, callsign, joined_at, avatar_url, bio, status,
                                is_treasury, earned_credit, earned_surplus,
                                purpose, goal_amount, deadline_at, lifecycle, paused, updated_at
                            ) VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?, ?, 'bounded', 0, ?)
                        `).run(
                            enterprisePubkey, callsign, createdAt, photoUrl, desc, status,
                            purpose, goal, deadline, updatedAt
                        );
                    } else {
                        targetDb.prepare(`
                            UPDATE members SET
                                is_treasury = 1,
                                lifecycle = 'bounded',
                                purpose = COALESCE(purpose, ?),
                                goal_amount = COALESCE(goal_amount, ?),
                                deadline_at = COALESCE(deadline_at, ?),
                                status = COALESCE(status, ?),
                                updated_at = ?
                            WHERE public_key = ?
                        `).run(purpose, goal, deadline, status, updatedAt, enterprisePubkey);
                    }

                    // Ensure account exists
                    targetDb.prepare(
                        "INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)"
                    ).run(enterprisePubkey);

                    if (p.creator_pubkey) {
                        const creatorExists = targetDb.prepare("SELECT 1 FROM members WHERE public_key = ?").get(p.creator_pubkey);
                        if (creatorExists) {
                            targetDb.prepare(`
                                INSERT OR IGNORE INTO treasury_operators (
                                    treasury_pubkey, member_pubkey, role, granted_at, granted_by
                                ) VALUES (?, ?, 'lead', ?, 'migration:projects')
                            `).run(enterprisePubkey, p.creator_pubkey, createdAt);

                            targetDb.prepare(
                                "UPDATE members SET can_operate = 1 WHERE public_key = ?"
                            ).run(p.creator_pubkey);
                        }
                    }

                    // Mark project as migrated in source table
                    targetDb.prepare(`
                        UPDATE projects SET
                            migrated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                            enterprise_pubkey = ?
                        WHERE id = ?
                    `).run(enterprisePubkey, p.id);
                })();

                migratedProjects++;
            }
        }
    } catch (e: any) {
        console.error('[Migration] Failed to migrate projects table:', e.message);
    }

    // 2. Migrate Commons proposal blobs from node_config
    try {
        const configCheck = targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='node_config'").get();
        if (configCheck) {
            const cpRow = targetDb.prepare(
                "SELECT value FROM node_config WHERE key = 'commons_projects'"
            ).get() as any;

            if (cpRow && cpRow.value) {
                let proposals: any[] = [];
                try {
                    proposals = JSON.parse(cpRow.value);
                } catch (e) {
                    console.error('[Migration] Failed to parse commons_projects JSON:', e);
                }

                if (Array.isArray(proposals) && proposals.length > 0) {
                    let modified = false;
                    for (const prop of proposals) {
                        if (prop.migrated) continue;

                        const enterprisePubkey = prop.id;
                        const callsign = getUniqueCallsign(prop.title, enterprisePubkey);
                        const desc = prop.description || '';
                        const purpose = desc || prop.title;
                        const goal = prop.requestedAmount != null ? Number(prop.requestedAmount) : null;
                        const status = (prop.status || 'proposed').toLowerCase();
                        const createdAt = prop.createdAt || new Date().toISOString();

                        targetDb.transaction(() => {
                            const existingMember = targetDb.prepare(
                                "SELECT public_key, is_treasury FROM members WHERE public_key = ?"
                            ).get(enterprisePubkey) as any;

                            if (!existingMember) {
                                targetDb.prepare(`
                                    INSERT INTO members (
                                        public_key, callsign, joined_at, bio, status,
                                        is_treasury, earned_credit, earned_surplus,
                                        purpose, goal_amount, lifecycle, paused, updated_at
                                    ) VALUES (?, ?, ?, ?, ?, 1, 0, 0, ?, ?, 'bounded', 0, ?)
                                `).run(
                                    enterprisePubkey, callsign, createdAt, desc, status,
                                    purpose, goal, createdAt
                                );
                            } else {
                                targetDb.prepare(`
                                    UPDATE members SET
                                        is_treasury = 1,
                                        lifecycle = 'bounded',
                                        purpose = COALESCE(purpose, ?),
                                        goal_amount = COALESCE(goal_amount, ?),
                                        status = COALESCE(status, ?),
                                        updated_at = ?
                                    WHERE public_key = ?
                                `).run(purpose, goal, status, createdAt, enterprisePubkey);
                            }

                            targetDb.prepare(
                                "INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)"
                            ).run(enterprisePubkey);

                            if (prop.proposerPubkey) {
                                const proposerExists = targetDb.prepare("SELECT 1 FROM members WHERE public_key = ?").get(prop.proposerPubkey);
                                if (proposerExists) {
                                    targetDb.prepare(`
                                        INSERT OR IGNORE INTO treasury_operators (
                                            treasury_pubkey, member_pubkey, role, granted_at, granted_by
                                        ) VALUES (?, ?, 'lead', ?, 'migration:commons_projects')
                                    `).run(enterprisePubkey, prop.proposerPubkey, createdAt);

                                    targetDb.prepare(
                                        "UPDATE members SET can_operate = 1 WHERE public_key = ?"
                                    ).run(prop.proposerPubkey);
                                }
                            }
                        })();

                        prop.migrated = true;
                        prop.migratedAt = new Date().toISOString();
                        prop.enterprisePubkey = enterprisePubkey;
                        modified = true;
                        migratedCommonsProposals++;
                    }

                    if (modified) {
                        targetDb.prepare(
                            "UPDATE node_config SET value = ? WHERE key = 'commons_projects'"
                        ).run(JSON.stringify(proposals));
                    }
                }
            }
        }
    } catch (e: any) {
        console.error('[Migration] Failed to migrate commons_projects:', e.message);
    }

    if (migratedProjects > 0 || migratedCommonsProposals > 0) {
        console.log(`🏛️ [Migration] Unified into enterprises: ${migratedProjects} project(s), ${migratedCommonsProposals} proposal(s).`);
    }

    return { migratedProjects, migratedCommonsProposals };
}
