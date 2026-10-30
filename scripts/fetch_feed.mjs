/**
 * Builds the PrizePicks props feed that GitHub Pages serves.
 *
 *   node scripts/fetch_feed.mjs --out docs
 *
 * Runs on a schedule in .github/workflows/refresh.yml, and by hand whenever
 * you want to see what the ads would get right now.
 *
 * No dependencies. Node 20+ for global fetch.
 *
 * ONE REQUEST PER RUN.
 * partner-api returns every sport in a single ~30 MB response and rate-limits
 * hard (HTTP 429). A 429 stalls every board, not just this one, so this script
 * fetches exactly once and slices locally. Never add a second fetch, and never
 * shorten the workflow's cron.
 */

const API_URL = 'https://partner-api.prizepicks.com/projections';

// Sports the ads can show. Order is the order the picker offers them.
const SPORTS = [
  { league: 'NBA',    label: 'NBA',              dir: 'nba',    ppid: 'NBA'    },
  { league: 'NFL',    label: 'NFL',              dir: 'nfl',    ppid: 'NFL'    },
  { league: 'CFB',    label: 'COLLEGE FOOTBALL', dir: 'ncaafb', ppid: 'NCAAFB' },
  { league: 'TENNIS', label: 'TENNIS',           dir: null,     ppid: null     }
];

const LOOKAHEAD_H = 168;  // a full week: the NFL plays weekly, so 72h sees only TNF
const MAX_GAMES   = 6;    // matchups offered per sport
const EXPIRES_MIN = 45;   // see the staleness note in README before shortening

// Tennis is two people, not two squads: it cannot field six players, and one
// line per player makes three picks impossible. It gets its own bar.
const RULES = {
  TENNIS:  { minPlayers: 2, minPicks: 3, onePerPlayer: false },
  DEFAULT: { minPlayers: 6, minPicks: 6, onePerPlayer: true  }
};
const ruleFor = l => RULES[l] || RULES.DEFAULT;

// Publishing nothing beats publishing a board the ad cannot play.
const MIN_SPORTS = 1;

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map(s => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ') || true])
);
const OUT_DIR = args.out || 'docs';

const GROUP = s => {
  s = String(s).toLowerCase();
  if (/pass/.test(s)) return 'PASSING';
  if (/rush|carr/.test(s)) return 'RUSHING';
  if (/rec/.test(s)) return 'RECEIVING';
  if (/point|pts|3pt/.test(s)) return 'SCORING';
  if (/reb/.test(s)) return 'REBOUNDING';
  if (/assist/.test(s)) return 'PLAYMAKING';
  if (/ace|game|set|break/.test(s)) return 'MATCH';
  return 'OTHER';
};

/* display_name is blank on roughly a third of rows; name is the fallback. */
const pname = a => ((a.display_name || '').trim()) || ((a.name || '').trim());

async function main() {
  const res = await fetch(API_URL, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
                    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
    }
  });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const d = await res.json();

  const inc = {};
  for (const o of d.included) (inc[o.type] = inc[o.type] || {})[o.id] = o.attributes;
  const lgs = inc.league || {}, pls = inc.new_player || {};
  const rel = (p, k) => {
    const r = p.relationships && p.relationships[k] && p.relationships[k].data;
    return r ? r.id : null;
  };

  /* Jersey art, never headshots.
     PrizePicks serves a team-coloured jersey carrying the player's number at
       /images/teams/<dir>/<TEAM_PPID>/<number>.webp
     The ppid lives on the `team` includes and the directory is the league's own
     prefix lowercased -- ncaafb for college football, not cfb. The API's own
     image_url is a player photo for every league but the NFL, so it is unused.
     URLs are not verified here: HEAD-checking a few hundred of them every five
     minutes would be tens of thousands of CDN requests a day, and the ad falls
     back to a drawn shirt on its own when one 404s. */
  const TEAM_PPID = {};
  for (const o of d.included) {
    if (o.type !== 'team') continue;
    const a = o.attributes, pp = a.ppid || '';
    if (pp.indexOf('_team_') < 0 || !a.abbreviation) continue;
    TEAM_PPID[pp.split('_team_')[0] + '|' + a.abbreviation] = pp;
  }
  function jerseyUrl(sport, team, jersey) {
    if (!sport.dir) return '';
    const num = String(jersey == null ? '' : jersey).trim();
    if (!/^\d{1,2}$/.test(num)) return '';
    const pp = TEAM_PPID[sport.ppid + '|' + team];
    return pp ? `https://static.prizepicks.com/images/teams/${sport.dir}/${pp}/${num}.webp` : '';
  }

  const now = Date.now();
  function rowsFor(sport) {
    const out = [];
    for (const p of d.data) {
      const li = rel(p, 'league');
      if (!li || (lgs[li] || {}).name !== sport.league) continue;
      const a = p.attributes;
      if (a.status !== 'pre_game' || a.odds_type !== 'standard' || a.is_combo) continue;
      if (a.allowed_wager_types && a.allowed_wager_types.indexOf('under_or_over') < 0) continue;
      const st = Date.parse(a.start_time || '');
      if (!st || st < now || st > now + LOOKAHEAD_H * 3600e3) continue;
      const pa = pls[rel(p, 'new_player')] || {};
      const n = pname(pa);
      const gid = rel(p, 'game');
      if (!n || !gid) continue;
      out.push({
        id: String(p.id), player_id: String(rel(p, 'new_player')), game_id: String(gid),
        player: n, team: pa.team || '', team_name: pa.team_name || pa.market || '',
        opp: a.description || '', pos: pa.position || '',
        jersey: String(pa.jersey_number == null ? '' : pa.jersey_number).trim(),
        stat: a.stat_display_name || a.stat_type || '',
        stat_group: GROUP(a.stat_display_name || a.stat_type),
        line: Number(a.line_score), period: 'FULL', league: sport.league,
        odds_type: 'standard', directions: ['more', 'less'],
        is_promo: false, is_combo: false, status: 'pre_game',
        start: a.start_time, end: '', is_live: false,
        trend: Number(a.trending_count || 0),
        image_url: jerseyUrl(sport, pa.team, pa.jersey_number),
        _st: st
      });
    }
    return out;
  }

  function pickGames(rows, league) {
    const R = ruleFor(league), by = {}, out = [];
    for (const r of rows) (by[r.game_id] = by[r.game_id] || []).push(r);
    for (const id of Object.keys(by).sort((a, b) => by[a][0]._st - by[b][0]._st)) {
      const sorted = by[id].sort((a, b) => b.trend - a.trend);
      const seen = {}, g = [];
      for (const r of sorted) {
        const k = R.onePerPlayer ? r.player_id : r.player_id + '|' + r.stat + '|' + r.line;
        if (!seen[k]) { seen[k] = 1; g.push(r); }
      }
      const teams = [...new Set(g.map(r => r.team))];
      const players = new Set(g.map(r => r.player_id)).size;
      if (g.length < R.minPicks || players < R.minPlayers || teams.length !== 2) continue;
      out.push(g.slice(0, 18));
      if (out.length >= MAX_GAMES) break;
    }
    return out;
  }

  const fetched = new Date();
  const expires = new Date(fetched.getTime() + EXPIRES_MIN * 60e3);
  const fs = await import('node:fs');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const manifest = { schema_version: 1, fetched_at: fetched.toISOString(),
                     expires_at: expires.toISOString(), sports: [] };

  for (const sport of SPORTS) {
    const games = pickGames(rowsFor(sport), sport.league);
    if (!games.length) { console.log(`${sport.league}: no matchup qualified`); continue; }
    const picks = [].concat(...games);
    picks.forEach((p, i) => {
      p.selection_rank = i + 1;
      p.serve_until = expires.toISOString();
      p.aggregation_type = 'TOP|CURRENT_GAME';
      delete p._st;
    });
    const envelope = {
      schema_version: 1, view: 'CURRENT_GAME', mode: 'playable',
      fetched_at: fetched.toISOString(), expires_at: expires.toISOString(),
      served_at: fetched.toISOString(),
      total: String(picks.length), returned: String(picks.length),
      game: null, league: sport.league, label: sport.label, picks
    };
    fs.writeFileSync(`${OUT_DIR}/${sport.league.toLowerCase()}.json`, JSON.stringify(envelope));
    manifest.sports.push({ league: sport.league, label: sport.label,
                           matchups: games.length, picks: picks.length,
                           file: sport.league.toLowerCase() + '.json' });
    const art = picks.filter(p => p.image_url).length;
    console.log(`${sport.league}: ${games.length} matchups, ${picks.length} picks, ${art} with jersey art`);
  }

  if (manifest.sports.length < MIN_SPORTS) {
    // Exit non-zero so the workflow fails and Pages keeps the previous deploy.
    // A stale-but-complete board beats an empty one.
    console.error(`only ${manifest.sports.length} sport(s) qualified; refusing to publish`);
    process.exit(1);
  }

  fs.writeFileSync(`${OUT_DIR}/manifest.json`, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(`${OUT_DIR}/.nojekyll`, '');
  console.log(`\nwrote ${manifest.sports.length} sport file(s), expires ${manifest.expires_at}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
