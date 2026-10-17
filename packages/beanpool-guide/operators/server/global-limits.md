---
slug: global-limits
title: Limits on a global community
summary: The limits that keep a global community's cost flat: listings archived after 90 days without a change, 5 photos a listing, the nearest 500 listings on a phone, 3 place watches. What each does, and how to change it.
related: showcase, rate-limits, backups-and-replicas, updates-and-health
---

A global community (NODE_PROFILE=global) lets anyone join from anywhere, so without limits what it stores grows without end. Four limits keep its cost flat. A local community has none of them, except the photo cap every community has, and the place watch cap, which only applies where there are place watches.

The members' guide lists the same numbers, in "The global community's limits". If you change one, members still read the default there.

## The limits

- **A listing is archived 90 days after it last changed**, with its photos. A local community: never. Setting: LISTING_ARCHIVE_DAYS, from 30 to 3650.
- **5 photos a listing or an event**, on every community. No setting.
- **A member's phone keeps the nearest 500 listings within 250 km** of their area. A local community: every listing. Settings: NEARBY_LISTINGS_MAX and NEARBY_LISTINGS_RADIUS_KM, each from 1 to 2000.
- **3 places a member may watch**, on every community that keeps the directory (a global community does; a local one doesn't). Setting: PLACE_WATCHES_MAX, from 1 to 20.

Each setting goes in the server's .env, then run docker compose up -d. Unset, it is the default above. A value out of its range, or not a whole number, is the default too, and the log says so once. Set the same values in the .env of each standby, so that a standby that takes over keeps them.

There is no setting for the photo cap: the apps offer five photo slots, so a lower number would meet five slots in the apps.

## The 90-day archive

A switch, **retention**, turns it on: on for a global community, off for a local one. At start the log says "Retention is on" with the number of days.

Once an hour the main server looks for Offers and Needs that nothing has changed in that many days. Changed means an edit, including saving one unchanged, a pause, or putting one back up. A message about a listing doesn't count.

- A listing still up is taken off the Market as its author's own removal takes it: cancelled, and every member's app drops it. Its author gets one notification for the run, with their Marketplace Activity alerts.
- Its photos are deleted. So are the photos of a listing taken down or finished that long ago.
- Its words stay in the database; the apps no longer show the listing.
- Left alone: a listing with a deal asked for or under way on it, one a report waits on or hidden for the moderators (so a moderator sees it as it was; put back up, it has another 90 days), one a keeper's wage claim waits on (an enterprise asked to pay for the job and can't yet; the claim is paid when it can), and copies of another community's listings.

At most 200 listings go in one run; the rest go in the next hour's runs. Each listing goes in its own transaction, so a run stopped halfway leaves every listing either whole or archived.

A deleted photo's row goes at once, so no one can open it again. The file goes with the image clean-up that runs every day, which the archive brings forward to about a minute later. It takes 2,000 files a pass on a disk and 500 on a bucket (IMAGE_STORE=s3), a minute apart, until none are left.

A standby archives nothing of its own: it copies the result from the main server, photo deletions included.

## Changing the switch

There is no screen for it in Settings. It is a row in the server's node_config, nodeProfile.retention, set to true or false. Like every profile switch it travels with backups and to standbys.

To turn the archive off on a global community, run on the server: docker compose exec -u node beanpool-node node -e "require('better-sqlite3')('/data/state.db').prepare(\"INSERT INTO node_config (key, value) VALUES ('nodeProfile.retention', 'false') ON CONFLICT(key) DO UPDATE SET value = excluded.value\").run()"

To turn it on on a local community, run the same with 'true' in place of 'false'. Its members will see listings go after the number of days set, so tell them first.
