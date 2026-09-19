# Owners & admins

> **Operator manual — node Settings.** Where to find it: `/settings` → **People & Safety** →
> **Owners & admins**. The screen is `apps/manager/src/components/modules/NodeRolesPanel.tsx`; keep its
> wording and this page in step.
>
> **Seam:** there is no node (operator) manual yet — the member manual (#936, `apps/website/guide/`) is
> for members and deliberately says nothing about running a node. When the node manual lands, move this
> page into it as-is.

## What it is

The people who run this node, and what each of them may do.

| Role | What they can do |
|---|---|
| 👑 **Owner** | Everything in Settings, including adding and removing other owners, admins and moderators. A community can have more than one owner. |
| ⚡ **Admin** | Run the community day to day — members, moderation, invites, backups — but not add or remove owners, admins or moderators. |
| 🛡️ **Moderator** | For now a label only. It does not open Settings and gives no extra powers. |

Each person holds one role at most. Giving someone a new role replaces the one they had.

Owners and admins open Settings from the BeanPool app with their own key: **Settings → 🛡️ Manage
<community name>**, which the app shows only to people the node says hold one of those roles. The admin
password still works too, and counts as an owner.

## Who sees what

- **Owners** — signed in with their key, or with the admin password — see the list and can add and remove people.
- **Admins** — signed in with their key — see the list, read-only.
- Moderators and ordinary members can't open Settings at all.

## Adding someone

1. Type part of their callsign, or paste their full public key.
2. Pick them, then choose **Owner**, **Admin** or **Moderator**.
3. **Continue** shows what they will be able to do, in plain words. Nothing changes until you press **Yes**.

## Removing someone

Press **Remove** on their row. You are asked once more before anything happens. Removing an owner or admin
takes away their access to Settings straight away; removing yourself signs you out.

## When the node says no

The node checks every change. If it refuses, the screen shows its reason exactly as it gave it. The usual ones:

| The node says | What it means |
|---|---|
| *Only an owner may grant the admin role* (or *…revoke…*) | You're signed in as an admin. Ask an owner. |
| *Only an owner may grant the owner role* | Same — once a community has an owner, only an owner can add another. |
| *Cannot remove the last owner* | Every community keeps at least one owner. Add another owner first, then remove this one. |
| *Only active accounts can hold a node role* | The member is suspended. Suspending or removing someone takes their role away. If the community's vote overturns a suspension the role comes back by itself; otherwise add them again once they're active. |
| *Member not found* | The pasted key isn't a member of this community. |
| *Treasury accounts cannot hold a node role* | An enterprise's treasury is not a person. |

## A brand-new node

A new node has no owner. The screen then says **"This community has no owner yet — add yourself"**:

- signed in with the **admin password** (the only way in on a brand-new node — nobody can sign in with
  their key until they hold a role): press **Find myself**, search for your own callsign, choose **Owner**
  and confirm. After that, **Manage** appears in your app.
- signed in with your **key** (you are an admin, but the node has no owner): press **Make me the owner** and confirm.

While a node has no owner, the node lets whoever is signed in make the first one. Do it straight away.
