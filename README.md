# prizepicks-feed

The props feed the PrizePicks playable ads read, served as static JSON from
GitHub Pages.

```
partner-api.prizepicks.com  ──▶  GitHub Actions (every 5 min)  ──▶  GitHub Pages  ──▶  ads
         one request                 scripts/fetch_feed.mjs            docs/*.json
```

**Base URL:** `https://ginawu-applovin.github.io/prizepicks-feed/`

| File | What it is |
|---|---|
| `manifest.json` | which sports are live right now, and their file names |
| `nba.json` `nfl.json` `cfb.json` `tennis.json` | one envelope per sport, every matchup it carries |

Pages sends `access-control-allow-origin: *`, which is what lets an ad in a
webview read these at all.

## One request per run

`partner-api` returns every sport in one ~30 MB response and rate-limits hard
with HTTP 429. A 429 stalls every board that reads this API, not just ours. So
the script fetches **once** and slices locally. Do not add a second fetch, and
do not shorten the cron.

## Staleness, and why `expires_at` is 45 minutes

GitHub's 5-minute cron is a floor, not a promise — scheduled workflows are
routinely late under load, sometimes by 15-20 minutes. The ads reject a feed
whose `expires_at` has passed, so a tight window would make them fall back to
their baked snapshot every time a run slipped. 45 minutes absorbs the drift
while still being short enough that genuinely dead data is refused.

The ads poll every 5 minutes regardless. They display `fetched_at` — when the
data was produced — not when they last asked, so the timestamp on screen is a
real freshness signal rather than a heartbeat.

## When a build would publish something misleading, it fails on purpose

`fetch_feed.mjs` exits non-zero if no sport qualifies, and the workflow fails if
a sport's games have all started. A failed run deploys nothing, so Pages keeps
the previous good feed. A slightly older complete board beats an empty or
in-progress one.

## Jersey art

Picks carry `image_url` pointing at a team-coloured jersey with the player's
number on it:

```
https://static.prizepicks.com/images/teams/<nba|nfl|ncaafb>/<TEAM_PPID>/<number>.webp
```

That URL is built here, not returned by the API — the API's own `image_url` is a
player headshot for every league except the NFL, and the creatives don't use
faces. The directory is the league's ppid prefix lowercased, so college football
is `ncaafb`.

These are not verified at build time: HEAD-checking a few hundred URLs every
five minutes is tens of thousands of CDN requests a day, and the ad already
falls back to a drawn shirt when one fails to load.

**If PrizePicks ever changes that path scheme these go dead silently** — the feed
would still look healthy. The canary is the `with jersey art` count in the
Actions log dropping to zero.

## Sports

NBA, NFL, college football and tennis. Nothing names a season, so a sport drops
out when it stops fielding games and returns on its own.

Tennis has its own rule: a match is two people, so it cannot clear a six-player
bar, and one line per player makes three picks impossible. It qualifies on three
distinct lines across both players instead.

## Running it by hand

```bash
node scripts/fetch_feed.mjs --out docs
```

Node 20+. No dependencies.
