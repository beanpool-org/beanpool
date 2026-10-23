# BeanPool Watcher

A small app for the moderators of [r/beanpool](https://www.reddit.com/r/beanpool). When someone posts or comments in
r/beanpool, the moderators get a short notification on their phones, so a person can answer the question quickly.

## What it does

- **A new post** in r/beanpool sends one notification: **"New post in r/beanpool"**, the post's title, and its link.
- **A new comment** sends one notification: **"New comment in r/beanpool"**, the title of the post it is on, and its
  link.
- Tapping the notification opens the post or comment on Reddit, where a moderator answers it as a person.
- **The team's inbox (optional).** If the developers have set a second private topic (below), each new post or comment
  also sends one message there: its public text. A moderator's own tools read that topic on the moderator's own
  computer and sort what is new. For a question the members' guide answers, they draft a reply, with the help of an AI
  assistant, for a moderator to read, change and post by hand ([TRIAGE.md](TRIAGE.md)).

That is all it does. It **never posts, comments, votes, sends messages or moderates**: the app has no permission to
use Reddit's API at all (`"reddit": false` in `devvit.json`). It only listens for new posts and comments.

**What a notification never carries:** who wrote the post or comment (no username), or what a comment says. Only the
public title of the post and the public link.

**What the inbox carries, and never carries:** the post's or comment's id and link, the post's title and flair, the
text as written (at most 2,000 characters), when Reddit says it was made, and, for a comment, the link to what it
answers. It never carries who wrote it: no username, no account id, no user flair. The text is what the person wrote
in public, so it can mention someone by name. Nothing is posted from it automatically, and no reply goes up without a
moderator posting it.

**What it leaves out:** posts and comments Reddit has marked as spam or that are already deleted; moderators' and
admins' distinguished posts (the team's own announcements); posts and comments by the accounts the moderators list
in the app's install settings (the team's own, so their replies don't ping the team); and anything written by
AutoModerator or by another app's account. Every other new post and comment sends one notification. The inbox leaves
out exactly the same.

**Where notifications go:** to the moderators' own [ntfy](https://ntfy.sh) topic, a free, public push-notification
service: the ntfy app on a phone shows each message. The topic's address is set by the app's developer as a secret
setting (below) and is never shown to anyone. The inbox is a second topic on the same service, with its own secret
address. It is never the phones' topic (the app refuses to send the inbox there), and ntfy.sh is asked not to pass it
on to Google's push service. ntfy.sh keeps a message for 12 hours.

**What it keeps:** for each post or comment it has told the moderators about, a marker in the app's own Redis
storage for 7 days, so the same item never sends two notifications (Reddit can deliver one event more than once). The
inbox has a marker of its own. It keeps nothing else, and the markers hold no title, text or username.

**Operational notes**

- If the ntfy topic is not set, nothing is sent; the app's log says so. If the inbox topic is not set, nothing is
  sent there, and the log says nothing about it.
- If ntfy cannot be reached or does not answer within 10 seconds, that one notification is lost (the log says so); if
  Reddit delivers the event again, the app tries again. The same goes for the inbox. The two are sent side by side, so
  one failing never stops the other.
- A busy thread sends one notification per comment. r/beanpool is small, so they are not grouped.
- It is built for r/beanpool only and is not listed in the App Directory.

## Fetch Domains

The following domains are requested for this app:

- `ntfy.sh` - Used to send the moderators' notification: one HTTPS POST per new post or comment to the moderators'
  private ntfy topic, carrying the notification's title, the post title and the link. ntfy.sh is a public push
  notification service with a publicly documented API ([docs.ntfy.sh/publish](https://docs.ntfy.sh/publish/)).
  If the developers set the team's inbox topic, there is one more HTTPS POST per new post or comment, to that second
  private topic on the same service. It carries the item's public text and links, and never who wrote it (above,
  "What the inbox carries"). The app reads nothing back from ntfy.sh.

## Settings

Three developer secrets (global, set with the Devvit CLI, never in this code):

| Setting | What it is |
|---|---|
| `ntfyUrl` | The topic's full address, `https://ntfy.sh/<topic>`. The topic's name is its password. |
| `ntfyToken` | Optional: an ntfy access token, sent as `Authorization: Bearer`, if the topic needs one. |
| `agentNtfyUrl` | Optional: the team's inbox, a second topic's full address, never the same as `ntfyUrl`. No token is sent to it. Unset: no inbox. |

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

**11. The team's inbox (optional, any time after step 3).** This is a NEW private topic, never the phone's: the phone
would show every message. Its address goes from the clipboard to Devvit and to one file on the Mac, and never into the
shell's history. Devvit's prompt does show it as you paste it, so don't do this on a shared screen.

a. Make a new topic address and copy it:

```sh
printf 'https://ntfy.sh/bp-inbox-%s' "$(openssl rand -hex 16)" | pbcopy
```

b. Give it to the app. In `apps/reddit-watcher`, run this and paste at the prompt (Cmd-V):

```sh
npx devvit settings set agentNtfyUrl
```

c. Give it to the fetch script. This file is outside the repository, readable only by you:

```sh
(umask 077 && mkdir -p ~/.config/beanpool && pbpaste > ~/.config/beanpool/reddit-agent-topic) && chmod 600 ~/.config/beanpool/reddit-agent-topic && pbcopy < /dev/null
```

The last part empties the clipboard.

d. Check it. From the repository root, `node scripts/reddit-inbox.mjs` prints `reddit-inbox: nothing new.` (or the
new items). It refuses to run, and says how to fix it, if the file is missing, holds more than the one line, or other
accounts on the Mac can read it.

If the app was uploaded before this setting existed, run `npx devvit upload` and `npx devvit install r/beanpool` first.
A new post in r/beanpool then shows up the next time the script runs. What happens next is in [TRIAGE.md](TRIAGE.md).

**Later**

- A change: edit, `npm test`, `npx devvit upload` (or `npx devvit publish` once it is published), then
  `npx devvit install r/beanpool` — a new version does not move an existing installation by itself.
- A new topic: `npx devvit settings set ntfyUrl` again. A new inbox topic: step 11 again (both b and c).
- No more inbox: `npx devvit settings set agentNtfyUrl` and press Enter at the prompt without a value (empty is off),
  then `rm ~/.config/beanpool/reddit-agent-topic`. If Devvit refuses an empty value, type `off`. The app then sends
  nothing to the inbox, and its log says once per item that `agentNtfyUrl` is not a topic.
- Taking it off: `npx devvit uninstall r/beanpool`.

## For developers

- `src/notice.ts` — `toNotice(event)`: a trigger's payload in, the notification (or `null`) out. Pure.
- `src/agent-item.ts` — `toAgentItem(event)`: the same payload in, the inbox's JSON item (or `null`, exactly when
  `toNotice` gives `null`) out, and `agentMessage`, which keeps it under ntfy's 4,096-byte text limit. Pure.
- `src/ntfy.ts` — the topic check, the ntfy requests, `deliver` (the phone) and `deliverAgent` (the inbox): each once per
  item, with its own repeat marker, never logging a topic, the token, or what anyone wrote.
- `../../scripts/reddit-inbox.mjs` — the fetch script the director runs once an hour ([TRIAGE.md](TRIAGE.md)). It is
  plain Node, so its tests run in CI (`node --test scripts/reddit-inbox.test.mjs`, test-all.sh's `reddit_inbox`).
- `agents/reddit-sorter.md` — the agent type that sorts each new item (TRIAGE.md, step 2): Sonnet, with only Read, Glob
  and Grep. `.claude/` is git-ignored, so the director copies it there once (TRIAGE.md, "Setting it up, once").
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
