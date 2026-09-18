# Node Settings — information architecture

> **Status: DESIGN, agreed. Not built.** Companion to [`admin-surface.md`](./admin-surface.md), which
> covers *who* an admin is and *how they authenticate*. This covers *what they see*.
> Designed 2026-09-14 by Antigravity at Claude's brief; Claude's corrections are marked **⚠️**.
> Full unedited proposal in [`the-commons-discussion.md`](./the-commons-discussion.md).
>
> **Audience: a volunteer running ONE node for ONE community.** Multi-node needs shaped nothing here.

## 1. Codebase and look — settled

**`apps/manager` survives. `settings.html` + `settings.js` are deleted.** React 19 + Vite +
Tailwind, typed and unit-tested, against 231 KB of untyped vanilla JS with no build step and no
component model. Compile the manager to static assets and serve them at `/settings`.

**The manager's design system survives; its fleet IA dies.** Dark palette, typography, badge
hierarchy and modals stay. The node switcher, target picker and node-registration forms go.
`node-client.ts` stops taking a node URL and talks to `window.location.origin`.

**Cut outright:** `TopologyModule` (canvas physics for multi-node clusters — irrelevant to an island
node), `AiServicesModule` (third-party LLM log summarisation has no place on a sovereign off-grid
server), the web chat console (operators carry phones; nobody answers DMs from a desktop admin
panel), the live connection monitor (raw IPs and user-agent strings — sysadmin voyeurism; reduce to
`Connections: 18 active`), and the eight raw Sybil/wash-threshold number fields (handing a community
elder a box labelled "Isolated Branch Min Txns" guarantees broken fraud detection — hardcode them).

## 2. Home screen

What the operator sees the second they log in — status, then what needs them, then the shape of the
community:

1. **Header** — community name, public domain, appliance status:
   `🟢 Online · Ledger balanced (0 drift) · Backed up 3h ago · v1.4.2`
2. **Action required** — either `All clear` or the live list: `⚠️ 1 report pending`,
   `🎟️ 2 invites unclaimed`, `💾 Storage 82%`
3. **Four cards** — Members · Commons pool · Shared enterprises · Circulation this week
4. **Quick actions** — Invite a member · Create an enterprise · Run ledger audit · Download backup
5. **Suggest a change to BeanPool** — goes to the project team at beanpool.org, not to this node; the same form is in the member app and PWA Settings. What is stored and how it is triaged: [apps/feedback/README.md](../apps/feedback/README.md).

## 3. Navigation — four plain-English sections, not twelve technical tabs

| Section | Contains | Absorbs |
|---|---|---|
| **People & Safety** | directory, member drawer (tier badge, voucher, node role, freeze/suspend/prune), invites + QR, report triage | `members` `invites` `moderation` |
| **Shared Projects & Economy** | Commons pool, enterprises + **assigning keepers**, Decisions & Polls | `commons` |
| **Bulletin & News** | announcements with severity, Pulse channel curation | `pulse` + broadcast half of `comms` |
| **Appliance & Data** | backups + **restore wizard**, disk/CPU/logs, ledger audit, DNS/TLS/peering, node identity, access + break-glass | `backup` `system` `diagnostics` `connections` `identity` `network` |

`comms` splits — broadcasts move, the admin chat inbox is deleted.

## 4. First run — a cold-start wizard, not an empty dashboard

A fresh node has one person and no data. Show a five-step wizard instead of a dashboard:

1. **Name and locate** the community; verify the public address is reachable
2. **Enrol the owner key** — pair by QR from the phone, set TOTP, download the break-glass kit with
   an explicit "I have saved this off-node" checkbox
3. **Create the first enterprise** from a preset (food · infrastructure · machinery), appoint the
   operator as its first keeper, and post its first offer so the offer covenant is satisfied
4. **Seed the Commons** ⚠️ *see §6*
5. **Generate three founding invites** with printable QR cards

Exit to the home screen with `1/3 founding invites claimed · node ready for trade`.

## 5. What is still missing — six real first-month failures

Each of these is a thing that will actually happen, with no UI today:

1. **Lost phone / re-keying.** Someone drops their phone in a creek with no 12 words. Needs an
   operator-assisted re-enrolment that binds the existing balance and history to a new device key.
2. **Stalled escrow disputes.** Buyer says the firewood never came; seller says it's at the gate.
   Beans stranded in `pending` forever. ⚠️ *see §6*
3. **Storage runaway.** Members post high-res photos of machinery and produce; the SD card fills and
   SQLite crashes. Needs a disk breakdown (database vs media vs logs), an 80% warning, and a prune.
4. **Offboarding with a balance.** Someone leaves holding +300 or owing −150. Needs a wizard:
   donate or gift a surplus; formally write a debt off against the Commons before pruning.
5. **Printable QR invites.** SMS and email fail constantly in low-reception country. Onboarding
   happens at the Friday dinner. Needs a printable card with a scannable join code.
6. **Unclean shutdown reassurance.** Solar batteries die and the node loses power. On reboot, run
   `PRAGMA integrity_check` and say plainly: *"Recovered from power loss at 04:12. Database verified,
   no corruption."* A nervous volunteer needs to be told the community's money is intact.

## 6. ⚠️ Corrections — where this proposal contradicts decisions already made

**Three of these would quietly undo governance work, so they are not optional.**

1. **No demurrage slider, and no "set the rate" in the wizard.** The proposal puts a demurrage rate
   control in Shared Projects and again in first-run step 4. But changing a protocol parameter is a
   **rule Decision** under [`the-commons.md` §3.6](./the-commons.md) — one member, one vote, 60%. An
   admin slider that silently changes everyone's money is precisely the authority the Decision model
   exists to remove. First-run step 4 keeps only the optional bootstrap grant into the Commons; the
   rate is a protocol default until a community votes to change it.
2. **The escrow arbitrator is right, but it is not a quiet admin button.** It should be built — the
   in-app copy already promises dispute arbitration that does not exist, and stranded beans corrode
   trust in the currency faster than almost anything. But `Release to seller` / `Refund to buyer` /
   `Split` is one person moving someone else's money. It must carry the full provenance stamp
   (`auth_signer`), appear in a public record, and show both parties what was decided and by whom.
   Whether a contested resolution should escalate to a Decision is an open question — but a silent
   admin override is not acceptable.
3. **Keepers are not "Stewards".** The proposal renames enterprise operators to *Stewards*. That is
   the exact collision we removed twice: **`Steward` is an earned trust tier** in `protocol.ts`
   (`Newcomer | Resident | Steward | Elder`), which is why `db.ts` renamed the role to `keeper` in
   the first place. The settled vocabulary stands: **node → owner / admin · enterprise → lead keeper
   / keeper · group → convenor · tier → Steward.** ("Recovery Friends" for key-fragment holders is
   fine — that half is moot anyway, social recovery was scrapped.)

Two smaller fixes: the member drawer's tiers are **Newcomer / Resident / Steward / Elder**, not
"Newcomer → Active → Elder"; and the mobile drawer must not offer `Assign Newcomer Floor (50 Beans)`
— floors are **earned**, and the only admin levers are a vouch gift (25/50/100) or a tier badge.
A button that grants a floor directly contradicts the trust model.

## 7. Mobile drawer — five items, and only five

Strictly synchronous, human-blocking events. Everything else is web configuration.

| | Why it cannot wait |
|---|---|
| **Abuse report** | conflict in a small community spreads within hours |
| **Worker bid on an enterprise need** | someone is standing there ready to work and cannot start until escrow locks |
| **Task finished, release payment** | withholding pay for completed physical labour causes immediate friction |
| **Newcomer arrived** | ⚠️ *verify and welcome — not "assign a floor", see §6* |
| **Appliance alert** — disk >90%, backup failed >24h | imminent crash or unrecoverable data loss |

The principle behind the whole split: **a plan that expects an operator to sit at a desktop to
approve a worker's bid will fail.** Disputes happen at the community garden. If reactive work does
not land on the phone, it sits un-actioned for weeks.
