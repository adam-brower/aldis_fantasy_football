/**
 * survivor.js
 *
 * Renders the league Survivor Pool grid from data/survivor.json.
 * That file is hand-maintained — fetch.py never overwrites it.
 * See the "_readme" block at the top of data/survivor.json for the edit
 * instructions that get handed to leaguemates.
 *
 * Team colors are the official palettes from https://teampalettes.com/nfl
 */

// ── Official NFL palettes (primary, secondary) ────────────────────────────────
export const NFL_TEAMS = {
  BUF: { name: 'Buffalo Bills',        primary: '#00338D', secondary: '#C60C30' },
  MIA: { name: 'Miami Dolphins',       primary: '#008E97', secondary: '#FC4C02' },
  NE:  { name: 'New England Patriots', primary: '#002244', secondary: '#C60C30' },
  NYJ: { name: 'New York Jets',        primary: '#125740', secondary: '#FFFFFF' },

  BAL: { name: 'Baltimore Ravens',     primary: '#241773', secondary: '#000000' },
  CIN: { name: 'Cincinnati Bengals',   primary: '#FB4F14', secondary: '#000000' },
  CLE: { name: 'Cleveland Browns',     primary: '#311D00', secondary: '#FF3C00' },
  PIT: { name: 'Pittsburgh Steelers',  primary: '#101820', secondary: '#FFB612' },

  HOU: { name: 'Houston Texans',       primary: '#03202F', secondary: '#A71930' },
  IND: { name: 'Indianapolis Colts',   primary: '#002C5F', secondary: '#FFFFFF' },
  JAX: { name: 'Jacksonville Jaguars', primary: '#006778', secondary: '#D7A22A' },
  TEN: { name: 'Tennessee Titans',     primary: '#0C2340', secondary: '#4B92DB' },

  DEN: { name: 'Denver Broncos',       primary: '#FB4F14', secondary: '#002244' },
  KC:  { name: 'Kansas City Chiefs',   primary: '#E31837', secondary: '#FFB81C' },
  LV:  { name: 'Las Vegas Raiders',    primary: '#000000', secondary: '#A5ACAF' },
  LAC: { name: 'Los Angeles Chargers', primary: '#0080C6', secondary: '#FFC20E' },

  DAL: { name: 'Dallas Cowboys',       primary: '#003594', secondary: '#869397' },
  NYG: { name: 'New York Giants',      primary: '#0B2265', secondary: '#A71930' },
  PHI: { name: 'Philadelphia Eagles',  primary: '#004C54', secondary: '#A5ACAF' },
  WAS: { name: 'Washington Commanders',primary: '#5A1414', secondary: '#FFB612' },

  CHI: { name: 'Chicago Bears',        primary: '#0B162A', secondary: '#C83803' },
  DET: { name: 'Detroit Lions',        primary: '#0076B6', secondary: '#B0B7BC' },
  GB:  { name: 'Green Bay Packers',    primary: '#203731', secondary: '#FFB612' },
  MIN: { name: 'Minnesota Vikings',    primary: '#4F2683', secondary: '#FFC62F' },

  ATL: { name: 'Atlanta Falcons',      primary: '#A71930', secondary: '#000000' },
  CAR: { name: 'Carolina Panthers',    primary: '#101820', secondary: '#0085CA' },
  NO:  { name: 'New Orleans Saints',   primary: '#101820', secondary: '#D3BC8D' },
  TB:  { name: 'Tampa Bay Buccaneers', primary: '#D50A0A', secondary: '#34302B' },

  ARI: { name: 'Arizona Cardinals',    primary: '#97233F', secondary: '#000000' },
  LAR: { name: 'Los Angeles Rams',     primary: '#003594', secondary: '#FFA300' },
  SF:  { name: 'San Francisco 49ers',  primary: '#AA0000', secondary: '#B3995D' },
  SEA: { name: 'Seattle Seahawks',     primary: '#002244', secondary: '#69BE28' },
};

// Alternate abbreviations people actually type
const TEAM_ALIASES = {
  ARZ: 'ARI', AZ: 'ARI', CRD: 'ARI',
  GNB: 'GB',  GBP: 'GB',
  KAN: 'KC',  KCC: 'KC',
  LVR: 'LV',  OAK: 'LV', RAI: 'LV',
  SFO: 'SF',  SF49: 'SF',
  TAM: 'TB',  TBB: 'TB',
  NOR: 'NO',  NOS: 'NO',
  NWE: 'NE',
  WSH: 'WAS', WFT: 'WAS',
  JAC: 'JAX',
  LA:  'LAR', RAM: 'LAR', STL: 'LAR',
  SD:  'LAC', SDC: 'LAC',
  HST: 'HOU', CLV: 'CLE', BLT: 'BAL',
};

export function resolveTeam(code) {
  if (!code) return null;
  const key = String(code).trim().toUpperCase();
  const canon = NFL_TEAMS[key] ? key : (TEAM_ALIASES[key] ?? null);
  return canon ? { code: canon, ...NFL_TEAMS[canon] } : null;
}

/**
 * Parse a manually-entered score string (an override / offline fallback).
 * The picked team's points are always written FIRST: "27-20", "27 - 20".
 */
function parseScore(raw) {
  if (raw == null) return null;
  const nums = String(raw).match(/\d+/g);
  if (!nums || nums.length < 2) return null;
  return { pf: +nums[0], pa: +nums[1] };
}

// ── ESPN live results ─────────────────────────────────────────────────────────
// Public scoreboard endpoint — no key, CORS-open, one request per NFL week.
// Results are cached in sessionStorage so a page refresh doesn't re-hit ESPN:
// a week where every game is final is cached for the whole browser session;
// a week still in progress is re-fetched after 5 minutes.
const ESPN_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const LIVE_TTL_MS = 5 * 60 * 1000;

const _weekMem = new Map();

function ssGet(key) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (o.allFinal) return o;
    return (Date.now() - o.t) < LIVE_TTL_MS ? o : null;
  } catch (_) { return null; }
}
function ssSet(key, val) { try { sessionStorage.setItem(key, JSON.stringify(val)); } catch (_) {} }

/**
 * Fetch one NFL week and index it by team.
 * @returns {Object|null} { [teamCode]: { opp, pf, pa, home, won, tie, final, live } }
 */
async function fetchNflWeek(season, week) {
  const key = `sv:${season}:${week}`;
  if (_weekMem.has(key)) return _weekMem.get(key);

  const cached = ssGet(key);
  if (cached) { _weekMem.set(key, cached.map); return cached.map; }

  let map = null;
  try {
    const url = `${ESPN_SCOREBOARD}?dates=${season}&seasontype=2&week=${week}&limit=100`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('ESPN ' + res.status);
    const data = await res.json();

    map = {};
    let allFinal = (data.events ?? []).length > 0;

    for (const ev of data.events ?? []) {
      const comp = ev.competitions?.[0];
      const cs = comp?.competitors ?? [];
      if (cs.length < 2) continue;

      const st    = comp.status?.type ?? ev.status?.type ?? {};
      const final = st.completed === true;
      const live  = st.state === 'in';
      if (!final) allFinal = false;

      cs.forEach((c, i) => {
        const o    = cs[1 - i];
        const me   = resolveTeam(c.team?.abbreviation);
        const opp  = resolveTeam(o.team?.abbreviation);
        if (!me) return;
        const pf = c.score != null ? +c.score : null;
        const pa = o.score != null ? +o.score : null;
        map[me.code] = {
          opp:  opp ? opp.code : (o.team?.abbreviation ?? '?'),
          pf, pa,
          home: c.homeAway === 'home',
          won:  c.winner === true,
          tie:  final && pf != null && pf === pa,
          final, live,
        };
      });
    }
    ssSet(key, { t: Date.now(), allFinal, map });
  } catch (err) {
    console.warn(`Survivor: could not load NFL week ${week} from ESPN —`, err.message);
    map = null;   // fall back to whatever is written in survivor.json
  }

  _weekMem.set(key, map);
  return map;
}

/**
 * Merge a JSON pick with the live ESPN result for that week.
 * Anything written by hand in survivor.json always wins, so the grid can be
 * corrected (or shown offline) without touching this code.
 */
function resolvePick(pick, live) {
  if (!pick || !pick.team) return null;
  const t     = resolveTeam(pick.team);
  const code  = t ? t.code : String(pick.team).toUpperCase();
  const game  = live ? live[code] : null;

  const manualScore = parseScore(pick.score);
  const manualOpp   = pick.opponent ? (resolveTeam(pick.opponent)?.code ?? pick.opponent) : null;

  const pf   = manualScore ? manualScore.pf : game?.pf ?? null;
  const pa   = manualScore ? manualScore.pa : game?.pa ?? null;
  const opp  = manualOpp ?? game?.opp ?? null;
  const home = game ? game.home : null;

  // Loss precedence: explicit flag → live ESPN result → manual score → unknown
  let lost = false;
  if (typeof pick.lost === 'boolean')      lost = pick.lost;
  else if (game && game.final)             lost = !game.won && !game.tie;
  else if (manualScore)                    lost = manualScore.pf < manualScore.pa;

  // Two short lines under the abbreviation so 18 columns still fit the card:
  //   17 - 34
  //   @ NYG
  const played    = pf != null && pa != null && (game ? (game.final || game.live) : true);
  const scoreText = played ? `${pf} - ${pa}` : '';
  const oppText   = opp ? `${home === false ? '@' : 'vs'} ${opp}` : '';

  return { code, team: t, lost, opp, pf, pa, scoreText, oppText,
           live: !!game?.live, final: game ? game.final : null };
}

// ── Data loading ──────────────────────────────────────────────────────────────
let _cache = null;
export async function fetchSurvivorData() {
  if (_cache) return _cache;
  try {
    const res = await fetch('./data/survivor.json?t=' + Date.now());
    if (!res.ok) return (_cache = { seasons: {} });
    _cache = await res.json();
  } catch (_) {
    _cache = { seasons: {} };
  }
  return _cache;
}

// ── Render ────────────────────────────────────────────────────────────────────
/**
 * Render the survivor grid for one season.
 *
 * Paints immediately from survivor.json, then pulls the real scores from ESPN
 * (one request per week that actually has picks) and repaints. If ESPN is
 * unreachable the first paint simply stands.
 *
 * @param {number|string} season  e.g. 2025
 * @returns {boolean} true if a grid was rendered (false = no data, hide section)
 */
export async function renderSurvivor(season) {
  const section = document.getElementById('sec-survivor');
  const grid    = document.getElementById('survivor-grid');
  if (!section || !grid) return false;

  const all = await fetchSurvivorData();
  const s = all?.seasons?.[String(season)];
  if (!s || !Array.isArray(s.managers) || s.managers.length === 0) {
    section.style.display = 'none';
    return false;
  }

  section.style.display = '';
  paint(s, {}, 'loading');          // instant paint from the JSON alone

  // Which NFL weeks does anyone actually have a pick in?
  const weeks = new Set();
  s.managers.forEach(m => (m.picks ?? []).forEach((p, i) => { if (p && p.team) weeks.add(i + 1); }));

  const results = {};
  await Promise.allSettled(
    [...weeks].map(w => fetchNflWeek(season, w).then(map => { if (map) results[w] = map; }))
  );
  const gotAny = Object.keys(results).length > 0;
  paint(s, results, gotAny ? 'live' : 'offline');
  return true;
}

function paint(s, results, mode) {
  const grid    = document.getElementById('survivor-grid');
  const summary = document.getElementById('survivor-summary');

  const winner = (s.winner ?? '').toLowerCase();   // pool champion, highlighted in gold

  const rows = s.managers.map(m => {
    const picks = (Array.isArray(m.picks) ? m.picks : [])
      .map((p, i) => resolvePick(p, results[i + 1]));
    const outIdx = picks.findIndex(p => p && p.lost);
    return { name: m.name, picks, alive: outIdx === -1, outWeek: outIdx === -1 ? null : outIdx + 1 };
  });

  const alive = rows.filter(r => r.alive).length;
  const lastWeekPicked = Math.max(0, ...rows.map(r => r.picks.length));

  // Always draw the full season. The table is laid out at a fixed width so
  // all 18 columns fit the card without horizontal scrolling on desktop.
  const totalWeeks = s.weeks ?? 18;

  let head = '<tr><th class="sv-name-col"></th>';
  for (let w = 1; w <= totalWeeks; w++) {
    head += `<th class="sv-week-th${w === lastWeekPicked ? ' sv-week-current' : ''}">Week ${w}</th>`;
  }
  head += '</tr>';

  let body = '';
  rows.forEach(r => {
    const meCls  = winner && r.name.toLowerCase() === winner ? ' sv-winner' : '';
    const outCls = r.alive ? '' : ' sv-out';
    body += `<tr class="sv-row${outCls}">`;
    const nameTip = meCls ? 'Won the pool'
                  : r.alive ? 'Still alive'
                  : `Eliminated in Week ${r.outWeek}`;
    body += `<td class="sv-name-col${meCls}${outCls}" title="${nameTip}"><span class="sv-name">${
      meCls ? '' : ''}${r.name}</span></td>`;

    for (let w = 1; w <= totalWeeks; w++) {
      const p = r.picks[w - 1];
      if (!p) { body += '<td class="sv-cell sv-empty"></td>'; continue; }

      const t = p.team;
      const style = p.lost
        ? ''
        : t ? `background:${t.primary};box-shadow:inset 0 -3px 0 ${t.secondary}66;`
            : 'background:var(--bg3);';

      const tip = [t ? t.name : p.code,
                   [p.scoreText, p.oppText].filter(Boolean).join(' '),
                   p.lost ? 'eliminated' : null].filter(Boolean).join(' · ');

      body += `<td class="sv-cell">
        <div class="sv-pick${p.lost ? ' sv-lost' : ''}${p.live ? ' sv-live' : ''}" style="${style}" title="${tip}">
          <span class="sv-abbr">${p.code}</span>
          ${p.scoreText ? `<span class="sv-score">${p.scoreText}</span>` : ''}
          ${p.oppText ? `<span class="sv-opp">${p.oppText}</span>` : ''}
        </div></td>`;
    }
    body += '</tr>';
  });

  grid.innerHTML = `<table id="survivor-table">` +
    `<colgroup><col class="sv-col-name" /><col span="${totalWeeks}" /></colgroup>` +
    `<thead>${head}</thead><tbody>${body}</tbody></table>`;

  fitNameColumn(grid);

  if (summary) {
    const note = mode === 'loading' ? '<span class="sv-stat sv-stat-dim">Loading scores…</span>'
               : mode === 'offline' ? '<span class="sv-stat sv-stat-warn">ESPN scores unavailable</span>'
               : '';
    summary.innerHTML = `
      <span class="sv-stat"><b>${alive}</b> still alive</span>
      <span class="sv-stat sv-stat-dim"><b>${rows.length - alive}</b> eliminated</span>
      <span class="sv-stat sv-stat-dim">Through Week <b>${lastWeekPicked || '—'}</b></span>
      ${note}`;
  }
}

/**
 * Size the manager-name column to the longest name actually on the board.
 *
 * The table is laid out `table-layout: fixed`, so the first column would
 * otherwise hold a hard-coded width and leave a ragged gap on the left that
 * doesn't match the card's padding on the right. Measuring the names keeps
 * both edges even, whatever the group is called this season.
 */
function fitNameColumn(grid) {
  const col = grid.querySelector('.sv-col-name');
  if (!col) return;
  const names = [...grid.querySelectorAll('.sv-name')];
  if (!names.length) return;

  const widest = names.reduce((mx, el) => Math.max(mx, el.getBoundingClientRect().width), 0);
  if (!widest) return;   // not laid out yet (hidden section) — CSS default stands

  // GAP is the cell's padding-right in the stylesheet, so the column ends up
  // exactly as wide as the longest name plus that padding — no dead space on
  // the left edge to mismatch the card's padding on the right.
  const GAP = 10;
  col.style.width = `${Math.ceil(widest) + GAP}px`;
}
