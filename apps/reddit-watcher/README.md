# BeanPool Watcher

A small app for the moderators of [r/beanpool](https://www.reddit.com/r/beanpool). When someone posts or comments in
r/beanpool, the moderators get a short notification on their phones, so a person can answer the question quickly.

## What it does

- **A new post** in r/beanpool sends one notification: **"New post in r/beanpool"**, the post's title, and its link.
- **A new comment** sends one notification: **"New comment in r/beanpool"**, the title of the post it is on, and its
  link.
- Tapping the notification opens the post or comment on Reddit, where a moderator answers it as a person.

That is all it does. It **never posts, comments, votes, sends messages or moderates**: the app has no permission to
use Reddit's API at all (`"reddit": false` in `devvit.json`). It only listens for new posts and comments.

**What a notification never carries:** who wrote the post or comment (no username), or what a comment says. Only the
public title of the post and the public link.

**What it leaves out:** posts and comments Reddit has marked as spam or that are already deleted; moderators' and
admins' distinguished posts (the team's own announcements); posts and comments by the accounts the moderators list
in the app's install settings (the team's own, so their replies don't ping the team); and anything written by
AutoModerator or by another app's account. Every other new post and comment sends one notification.

**Where notifications go:** to the moderators' own [ntfy](https://ntfy.sh) topic, a free, public push-notification
service: the ntfy app on a phone shows each message. The topic's address is set by the app's developer as a secret
setting (below) and is never shown to anyone.

**What it keeps:** for each post or comment it has told the moderators about, a marker in the app's own Redis
storage for 7 days, so the same item never sends two notifications (Reddit can deliver one event more than once).
It keeps nothing else, and the marker holds no title, text or username.

**Operational notes**

- If the ntfy topic is not set, nothing is sent; the app's log says so.
- If ntfy cannot be reached or does not answer within 10 seconds, that one notification is lost (the log says so); if
  Reddit delivers the event again, the app tries again.
- A busy thread sends one notification per comment. r/beanpool is small, so they are not grouped.
- It is built for r/beanpool only and is not listed in the App Directory.

## Fetch Domains

The following domains are requested for this app:

- `ntfy.sh` - Used to send the moderators' notification: one HTTPS POST per new post or comment to the moderators'
  private ntfy topic, carrying the notification's title, the post title and the link. ntfy.sh is a public push
  notification service with a publicly documented API ([docs.ntfy.sh/publish](https://docs.ntfy.sh/publish/)).
  Nothing is read back from it.

## Settings

Two developer secrets (global, set with the Devvit CLI, never in this code):

| Setting | What it is |
|---|---|
| `ntfyUrl` | The topic's full address, `https://ntfy.sh/<topic>`. The topic's name is its password. |
| `ntfyToken` | Optional: an ntfy access token, sent as `Authorization: Bearer`, if the topic needs one. |

One setting for the subreddit's moderators, on the app's Install Settings page:

| Setting | What it is |
|---|---|
| `quietUsernames` | The team's own usernames, comma-separated: their posts and comments send no notification. Empty: everyone's do. |

## Terms and privacy

- Terms: [beanpool.org/terms](https://beanpool.org/terms)
- Privacy policy: [beanpool.org/privacy](https://beanpool.org/privacy)
- Questions or problems: modmail [r/beanpool](https://www.reddit.com/message/compose?to=r/beanpool).

---

## Setting it up (the BeanPool team, once)

Each step is one command or one page; run them from this folder (`apps/reddit-watcher`) unless the step says
otherwise. Use the Reddit account that moderates r/beanpool throughout. The Devvit commands are from the
[Devvit CLI reference](https://developers.reddit.com/docs/guides/tools/devvit_cli).

**1. Register the app's name — once, outside this repository.**

```sh
mkdir -p ~/devvit-register && cd ~/devvit-register && npx devvit@0.15.0 init
```

A browser opens [developers.reddit.com/new](https://developers.reddit.com/new): sign in with the moderator account,
name the app **`beanpool-watcher`**, pick any template. When the command finishes, `rm -rf ~/devvit-register`. This
also signs the CLI in. If the name is taken, choose another and put it in `devvit.json`'s `"name"`.

Why outside: `devvit init` (and `devvit upload` for an app it can't find) runs `git init` in the folder it is in and
rewrites its `package.json`. Done here, that would make a second git repository inside ours.

**2. Install the tools and check who the CLI is signed in as.**

```sh
cd apps/reddit-watcher
npm ci
npx devvit whoami
```

It must name the moderator account. If it doesn't: `npx devvit login`.

**3. Upload the app.**

```sh
npx devvit upload
```

This builds the app, uploads a private version, sends the `ntfy.sh` domain to Reddit for review, and makes a small
playtest subreddit with the app installed (it prints its name). If it opens a browser to create an app or says
*"We've updated the app name"*, press Ctrl-C: the name in `devvit.json` is not the one from step 1. Then undo what it
changed, here in `apps/reddit-watcher` only (the `devvit.json` test keeps it from ever touching the repository's own
`.git`):

```sh
[ -f devvit.json ] && [ -d .git ] && rm -rf .git; git checkout -- package.json package-lock.json devvit.json
```

**4. Set the topic.**

```sh
npx devvit settings set ntfyUrl
```

At the prompt, paste the control room's topic URL, `https://ntfy.sh/<topic>`: the topic the registrar's `NTFY_URL`
Worker secret holds (`apps/registrar/README.md`, "Alerts to the admin's phone") and your ntfy app is subscribed to —
Cloudflare never shows a secret's value again, the ntfy app's subscription shows the topic. Only if that topic uses a
token: `npx devvit settings set ntfyToken`. `npx devvit settings list` shows which are set, never their values.

**5. Add the terms and privacy links.** On the app's page,
[developers.reddit.com/apps/beanpool-watcher](https://developers.reddit.com/apps/beanpool-watcher), put
`https://beanpool.org/terms` and `https://beanpool.org/privacy` in the app details form. Reddit requires both for any
app that fetches.

**6. Wait for `ntfy.sh` to be approved.** It appears under
[Developer Settings](https://developers.reddit.com/apps/beanpool-watcher/developer-settings) once it is (Reddit's
target is 1–2 business days).

**7. Test in the playtest subreddit.** Make a post there. The phone shows "New post in r/<playtest name>", and

```sh
npx devvit logs <playtest name>
```

shows `[reddit-watcher] a new post, told (HTTP 200)`.

**8. Install it on r/beanpool.**

```sh
npx devvit install r/beanpool
```

A private upload installs only on subreddits with fewer than 200 members. If r/beanpool has more, or if step 7's log
shows the request blocked even with `ntfy.sh` approved (Reddit counts fetch as a feature that needs its review), first
submit the app for Reddit's review:

```sh
npx devvit publish
```

It stays unlisted (only we can install it). Reddit emails when it is approved (they aim for 1–2 business days; their
rules say up to a week); then run `npx devvit install r/beanpool`.

**9. Name the team's own accounts.** Open the app's Install Settings for r/beanpool: from
[the app's page](https://developers.reddit.com/apps/beanpool-watcher), **Installed in communities** → r/beanpool. In
"Accounts that never ping", put the moderator account (and any other team account), comma-separated, and save. The
names stay in Reddit's settings, not in this repository.

**10. Test on r/beanpool.** A post from an account not in that list pings the phone; delete the test post afterwards.

**Later**

- A change: edit, `npm test`, `npx devvit upload` (or `npx devvit publish` once it is published), then
  `npx devvit install r/beanpool` — a new version does not move an existing installation by itself.
- A new topic: `npx devvit settings set ntfyUrl` again.
- Taking it off: `npx devvit uninstall r/beanpool`.

## For developers

- `src/notice.ts` — `toNotice(event)`: a trigger's payload in, the notification (or `null`) out. Pure.
- `src/ntfy.ts` — the topic check, the ntfy request, and `deliver`: once per item, never logging the topic or token.
- `src/server/` — the one endpoint Devvit calls (`/internal/triggers/new-item`), as in Reddit's
  [Devvit Web template](https://github.com/reddit/devvit-template-hello-world).
- `npm test` (vitest), `npm run typecheck`, `npm run build` (esbuild, CommonJS into `dist/server`, which Devvit runs).
  `src/config.test.ts` checks `devvit.json` with the CLI's own validator.

This folder is **not** in the repository's pnpm workspace (`pnpm-workspace.yaml` leaves it out): the Devvit CLI is
about 300 MB that no other package needs, so the root `pnpm install` and CI never install it, and CI does not run
these tests. Run them here after any change.

The triggers are `onPostCreate` and `onCommentCreate`, which Reddit sends after its safety checks, so spam it catches
never pings. `onPostSubmit` / `onCommentSubmit` come sooner but before those checks; the code reads both, so switching
is only `devvit.json` ([Trigger Event Catalog](https://developers.reddit.com/docs/capabilities/server/trigger-events)).
