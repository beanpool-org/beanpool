# BeanPool node watchdog

Host-side guard against a **hung node** — the container stays `running` but its
single JS thread spins to 100% CPU and the event loop dies, so it stops serving
HTTP. Docker's `restart: unless-stopped` can't catch this (the process never
exits). This is the 2026-07-18 test-node freeze: pinned at 100% CPU for 6 hours,
only cleared by a manual `docker restart`, with no stack captured.

## What it does

A tiny `bash` loop (systemd service) polls each node's `/api/community/info`
every 20 s. Three consecutive failures (~60 s) while the container is still
`running` ⇒ the node is hung, and the watchdog:

1. snapshots `docker logs` + `stats`/`top` to `/var/log/beanpool-watchdog/incident-*.log`;
2. sends `SIGUSR2` to the node → `NODE_OPTIONS=--report-on-signal` writes a
   Node.js **diagnostic report** (the blocked JS stack) to `/data/report.*.json`
   (persisted bind mount, so it survives the restart);
3. `docker restart`s the container.

Guards: skips containers that aren't running or (re)started < 90 s ago (so it
never fights a deploy or a boot), a 15-min post-restart cooldown, and a
crash-loop backstop (stops auto-restarting after 4 restarts/hour, logs for a
human instead). It only sends `SIGUSR2` to containers whose env actually has
`--report-on-signal` — otherwise SIGUSR2 would *kill* the node — so the flag can
be rolled out node-by-node while the watchdog guards them all.

## Prerequisite

The node containers must run with `--report-on-signal` for step 2 to produce a
report (already in the repo `docker-compose.yml` `NODE_OPTIONS`). Without it the
watchdog still restarts + captures logs, just no JS stack.

## Install (per host)

```sh
sudo install -m 0755 beanpool-watchdog.sh /usr/local/bin/beanpool-watchdog.sh
sudo install -m 0644 beanpool-watchdog.service /etc/systemd/system/beanpool-watchdog.service
sudo systemctl daemon-reload
sudo systemctl enable --now beanpool-watchdog.service
```

`BEANPOOL_WATCH_CONTAINERS` (space-separated) overrides which containers are
guarded — set it per host in the unit's `[Service]` section. Defaults cover the
qld host (test/mullum/bris).

## When a freeze is caught

```sh
tail -n 50 /var/log/beanpool-watchdog/watchdog.log      # timeline
ls -lt /root/BeanPool-Test/data/report.*.json           # diagnostic reports
```

The report's `javascriptStack.stack` is the blocked call stack — the root cause.
