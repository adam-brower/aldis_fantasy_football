/**
 * elo.js — ELO rating engine for Aldi's Fantasy Football
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two flavours are built on one generic engine:
 *
 *   1. SEASON ELO   — every team resets to 1000 at the start of each year and
 *                     moves week to week within that season only.
 *   2. CAREER ELO   — every *manager* starts at 1000 the first time they appear
 *                     in league history and carries their rating forward across
 *                     seasons, regressed partway back toward 1000 each offseason.
 *
 * ── The math ────────────────────────────────────────────────────────────────
 *
 * Expected score (standard logistic ELO):
 *
 *     E_a = 1 / (1 + 10^((R_b - R_a) / scale))
 *
 * Rating change for a game:
 *
 *     ΔR = K · movMult · weight · (S_a - E_a)
 *
 * where S_a is 1 for a win, 0 for a loss, 0.5 for a tie.
 *
 * `movMult` is a margin-of-victory multiplier in the style of FiveThirtyEight's
 * NFL ELO. It does two things, and both matter for fantasy:
 *
 *     movMult = ln(1 + normMargin) · ( 2.2 / (0.001 · eloDiffWinner + 2.2) )
 *               └──── margin ────┘   └──── autocorrelation correction ────┘
 *
 *   • The log term means a blowout is worth more than a squeaker, but with
 *     sharply diminishing returns — winning by 60 is not 30x more impressive
 *     than winning by 2. Raw margin would be far too noisy in fantasy, where a
 *     single boom week from one WR can swing 40 points.
 *
 *   • The autocorrelation term shrinks the multiplier when a heavy favourite
 *     wins big. Without it, strong teams run away with the rating because good
 *     teams naturally blow out bad ones — the correction is what keeps the
 *     system stable and self-limiting over many seasons. This is the single
 *     most important ingredient for robustness, and it is why margin-scaled
 *     ELO outperforms plain win/loss ELO here rather than just being noisier.
 *
 * `normMargin` divides the raw point margin by a per-game scale derived from
 * the league's own average weekly score, so the system is agnostic to scoring
 * settings and to combined (2-week) playoff rounds where scores roughly double:
 *
 *     marginScale = (leagueAvgWeeklyScore / 10) · weeksInGame
 *
 * With a ~110 pt/wk league that makes an 11-point win worth normMargin = 1.
 *
 * ELO is strictly zero-sum: whatever the winner gains, the loser loses.
 */

export const ELO_DEFAULTS = {
  base: 1000,          // starting rating
  K: 52,               // maximum swing per game before MOV/weight scaling
  scale: 600,          // logistic scale (a 600-pt edge ⇒ ~91% win prob)
  playoffWeight: 1.5,  // top-4 bracket games move the needle 1.5x as much
                       // (consolation games stay at 1x — see `bracket` below)
  regression: 0.25,    // career ELO: regress 25% toward base each offseason
};

/*
 * ── Tuning notes ────────────────────────────────────────────────────────────
 *
 * K and `scale` are the two dials that control how far ratings spread out.
 *
 *   K      — how many points a single game can move you. Bigger K = more
 *            week-to-week movement and a wider final spread.
 *   scale  — how many rating points equal a given win-probability edge.
 *            Raising it lets ratings drift further apart *without* the model
 *            claiming absurd certainty about any single matchup, which matters
 *            in fantasy: even a genuinely dominant team only wins ~70-80% of
 *            the time, so a 300-point gap should NOT imply a 90% favourite.
 *
 * K and `scale` are raised together on purpose. At K = 52 / scale = 600 a
 * 15-1 juggernaut finishes a season near 1260 and the league's worst team near
 * 770, while the most lopsided matchup in league history still only shows an
 * ~81% pre-game win probability. This is deliberately on the conservative side
 * of the useful range — with only three seasons on the books the ratings are
 * still finding their footing, and there is room to raise both dials later as
 * the sample grows.
 *
 * ── Where the ceiling is ────────────────────────────────────────────────────
 *
 * Cranking K does not break the system — it stays zero-sum and self-limiting at
 * any value. What it costs is predictive accuracy: a bigger K makes ratings
 * chase single-week noise (which in fantasy is mostly luck) instead of tracking
 * real skill. Measured walk-forward over every game in league history, where
 * each game's win probability comes only from ratings built out of prior games:
 *
 *     K / scale     Brier ↓    Hit rate ↑    career spread
 *     12 / 400      0.2427       55.1%           169
 *     24 / 400      0.2430       53.8%           279
 *     52 / 600      0.2453       53.8%           524   ← current
 *     70 / 700      0.2467       53.2%           665
 *     85 / 750      0.2484       51.9%           768
 *    100 / 800      0.2499       52.6%           870
 *    150 / 1000     0.2533       51.3%          1208
 *
 *     (coin-flip baseline: Brier 0.2500, hit rate 50%)
 *
 * Two things to read off that table. First, fantasy is genuinely close to a
 * coin flip week to week — even the best-tuned ELO only edges the baseline, and
 * that is a fact about the sport, not a flaw in the model. Second, there is a
 * real cliff: somewhere around K = 100 the ratings stop carrying information at
 * all and the model is no better than guessing. K = 70 sits comfortably inside
 * the useful range while still producing a wide, readable spread. K = 52 sits
 * one notch more conservative than that; 70 / 700 and even 85 / 750 stay
 * defensible if you want more movement later. Past 100 / 800 the numbers are
 * decoration rather than a rating.
 *
 * (Caveat: 156 games is a small sample, so the row-to-row gaps are inside the
 * noise. The monotone trend across the whole table is the meaningful part.)
 */

/** Logistic expected score for A against B. */
export function expectedScore(ratingA, ratingB, scale = ELO_DEFAULTS.scale) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / scale));
}

/** Margin-of-victory multiplier with the autocorrelation correction. */
function movMultiplier(margin, marginScale, eloDiffWinner) {
  const norm = marginScale > 0 ? Math.abs(margin) / marginScale : Math.abs(margin);
  const logTerm = Math.log(1 + norm);
  const correction = 2.2 / (0.001 * Math.max(0, eloDiffWinner) + 2.2);
  return logTerm * correction;
}

function round(x, n = 1) { const p = Math.pow(10, n); return Math.round(x * p) / p; }

/**
 * Turn a season's `schedule` object into a flat, ordered list of ELO games.
 * Combined playoff rounds (e.g. weeks 16-17 scored as one game) are summed into
 * a single game so a championship round isn't double-counted.
 *
 * Each game is tagged with a `bracket`:
 *
 *   'regular'     — regular-season game
 *   'playoff'     — a game between two teams that made the top-4 bracket.
 *                   These carry the 1.5x weight: they decide the title, and
 *                   both participants earned their way in.
 *   'consolation' — a post-season game involving anyone who missed the cut.
 *                   Weighted 1x. These are effectively exhibition games — half
 *                   the field has nothing left to play for, so letting them
 *                   move ratings 1.5x would reward (and punish) noise.
 *
 * @param {Object} schedule    week → array of matchups
 * @param {Object} opts
 * @param {number} opts.regularSeasonWeeks
 * @param {Array}  opts.combineWeeks   e.g. [[14,15],[16,17]]
 * @param {number} opts.season
 * @param {Array}  opts.teams          used to identify the top-4 seeds
 * @param {number} opts.playoffTeamCount  defaults to 4
 * @returns {Array} games
 */
export function buildGamesFromSchedule(schedule, opts = {}) {
  const combineWeeks = opts.combineWeeks ?? [];
  const regWeeks = opts.regularSeasonWeeks ?? 14;
  const season = opts.season ?? null;

  const weekToGroup = {};
  combineWeeks.forEach((grp, gi) => grp.forEach(w => { weekToGroup[w] = gi; }));

  const allWeeks = Object.keys(schedule).map(Number).sort((a, b) => a - b);

  // Which teams made the playoff bracket. Prefer ESPN's stored playoffSeed;
  // fall back to regular-season standings (wins, then points for).
  const teams = opts.teams ?? [];
  const nPlayoff = opts.playoffTeamCount ?? 4;
  const hasSeeds = teams.some(t => t.playoffSeed > 0);
  const topSeedIds = new Set(
    hasSeeds
      ? teams.filter(t => t.playoffSeed >= 1 && t.playoffSeed <= nPlayoff).map(t => t.id)
      : [...teams]
          .sort((a, b) => (b.wins ?? 0) - (a.wins ?? 0) || (b.pointsFor ?? 0) - (a.pointsFor ?? 0))
          .slice(0, nPlayoff)
          .map(t => t.id)
  );
  const bracketOf = (homeId, awayId, isPost) => {
    if (!isPost) return 'regular';
    if (!topSeedIds.size) return 'playoff';   // no seed info — treat as playoff
    return (topSeedIds.has(homeId) && topSeedIds.has(awayId)) ? 'playoff' : 'consolation';
  };

  // League-wide average score for a single week — used to normalise margins.
  let scoreSum = 0, scoreCount = 0;
  allWeeks.forEach(w => (schedule[w] ?? []).forEach(m => {
    if (m.isBye) return;
    if (m.homeScore > 0) { scoreSum += m.homeScore; scoreCount++; }
    if (m.awayScore > 0) { scoreSum += m.awayScore; scoreCount++; }
  }));
  const avgWeekly = scoreCount ? scoreSum / scoreCount : 100;

  const games = [];
  const doneGroups = new Set();

  allWeeks.forEach(w => {
    const gi = weekToGroup[w];

    if (gi !== undefined) {
      if (doneGroups.has(gi)) return;
      doneGroups.add(gi);
      const grpWeeks = combineWeeks[gi];
      const pairs = {};
      grpWeeks.forEach(gw => (schedule[gw] ?? []).forEach(m => {
        if (m.isBye) return;
        const key = `${m.homeTeamId}_${m.awayTeamId}`;
        if (!pairs[key]) pairs[key] = { homeId: m.homeTeamId, awayId: m.awayTeamId, homeScore: 0, awayScore: 0 };
        pairs[key].homeScore += m.homeScore;
        pairs[key].awayScore += m.awayScore;
      }));
      Object.values(pairs).forEach(p => {
        if (!(p.homeScore > 0 && p.awayScore > 0)) return;
        games.push({
          season,
          week: grpWeeks[0],
          sortWeek: grpWeeks[0],
          weekLabel: `Wk ${grpWeeks.join('–')}`,
          weeksInGame: grpWeeks.length,
          homeId: p.homeId, awayId: p.awayId,
          homeScore: round(p.homeScore, 2), awayScore: round(p.awayScore, 2),
          isPlayoff: true,
          bracket: bracketOf(p.homeId, p.awayId, true),
          avgWeekly,
        });
      });
    } else {
      (schedule[w] ?? []).forEach(m => {
        if (m.isBye) return;
        if (!(m.homeScore > 0 && m.awayScore > 0)) return;
        games.push({
          season,
          week: w,
          sortWeek: w,
          weekLabel: `Wk ${w}`,
          weeksInGame: 1,
          homeId: m.homeTeamId, awayId: m.awayTeamId,
          homeScore: m.homeScore, awayScore: m.awayScore,
          isPlayoff: w > regWeeks,
          bracket: bracketOf(m.homeTeamId, m.awayTeamId, w > regWeeks),
          avgWeekly,
        });
      });
    }
  });

  games.sort((a, b) => a.sortWeek - b.sortWeek);
  return games;
}

/**
 * Run the ELO engine over an ordered list of games.
 *
 * Games are grouped into "rounds" (all games sharing a season+week play
 * simultaneously, so every team in a round is rated against the ratings that
 * existed *before* that week — no ordering artefacts within a week).
 *
 * @param {Array}  games      from buildGamesFromSchedule, possibly concatenated
 *                            across seasons for career ELO
 * @param {Object} opts
 * @param {Function} opts.entityOf   game, side('home'|'away') → entity key
 * @param {Function} opts.labelOf    entity key → display label
 * @param {boolean}  opts.carryover  true = career mode (regress between seasons)
 * @param {Object}   opts.config     overrides for ELO_DEFAULTS
 */
export function runElo(games, opts = {}) {
  const cfg = { ...ELO_DEFAULTS, ...(opts.config ?? {}) };
  const entityOf = opts.entityOf ?? ((g, side) => side === 'home' ? g.homeId : g.awayId);
  const labelOf  = opts.labelOf  ?? (k => String(k));
  const carryover = !!opts.carryover;

  const ratings = {};   // entity → current rating
  const history = {};   // entity → [entry]
  const rounds = [];    // [{ season, week, weekLabel, key, ratings:{}, games:[] }]
  const points = [{ key: 'start', label: 'Start', season: null, week: 0, type: 'start' }];
  const snapshots = [{ ...{} }]; // ratings after each point (index-aligned with `points`)

  const ensure = (k) => {
    if (ratings[k] === undefined) {
      ratings[k] = cfg.base;
      history[k] = [{
        season: null, week: 0, weekLabel: 'Start', pointKey: 'start',
        opponent: null, opponentLabel: null,
        score: null, oppScore: null, result: 'start',
        before: cfg.base, after: cfg.base, delta: 0,
        winProb: null, isPlayoff: false, seasonStart: true,
      }];
    }
  };

  // Group games into rounds, preserving chronological order.
  const roundMap = new Map();
  games.forEach(g => {
    const key = `${g.season ?? 0}|${g.sortWeek}`;
    if (!roundMap.has(key)) roundMap.set(key, { season: g.season, week: g.sortWeek, weekLabel: g.weekLabel, key, games: [] });
    roundMap.get(key).games.push(g);
  });
  const orderedRounds = [...roundMap.values()].sort(
    (a, b) => (a.season ?? 0) - (b.season ?? 0) || a.week - b.week
  );

  let prevSeason = null;

  orderedRounds.forEach(round_ => {
    // Offseason regression for career mode.
    if (carryover && prevSeason !== null && round_.season !== prevSeason) {
      Object.keys(ratings).forEach(k => {
        const before = ratings[k];
        const after = before + (cfg.base - before) * cfg.regression;
        ratings[k] = after;
        history[k].push({
          season: round_.season, week: 0, weekLabel: `${round_.season} preseason`,
          pointKey: `${round_.season}|0`,
          opponent: null, opponentLabel: null, score: null, oppScore: null,
          result: 'regression', before, after, delta: after - before,
          winProb: null, isPlayoff: false, seasonStart: true,
        });
      });
      points.push({ key: `${round_.season}|0`, label: `${round_.season} ↺`, season: round_.season, week: 0, type: 'regression' });
      snapshots.push({ ...ratings });
    }
    prevSeason = round_.season;

    // Snapshot pre-round ratings so every game in the week uses the same base.
    round_.games.forEach(g => { ensure(entityOf(g, 'home')); ensure(entityOf(g, 'away')); });
    const pre = { ...ratings };
    const deltas = {};
    const detail = [];

    round_.games.forEach(g => {
      const a = entityOf(g, 'home');
      const b = entityOf(g, 'away');
      if (a === b) return;

      const Ra = pre[a], Rb = pre[b];
      const Ea = expectedScore(Ra, Rb, cfg.scale);
      const Eb = 1 - Ea;

      const aScore = g.homeScore, bScore = g.awayScore;
      const Sa = aScore > bScore ? 1 : aScore < bScore ? 0 : 0.5;
      const Sb = 1 - Sa;

      const margin = Math.abs(aScore - bScore);
      const marginScale = (g.avgWeekly / 10) * (g.weeksInGame ?? 1);
      // eloDiff from the winner's perspective (0 if a tie)
      const eloDiffWinner = Sa === 1 ? (Ra - Rb) : Sa === 0 ? (Rb - Ra) : 0;
      const mov = movMultiplier(margin, marginScale, eloDiffWinner);

      // Only true top-4 bracket games get the playoff bump; consolation
      // games between eliminated teams count the same as a regular week.
      const weight = g.bracket === 'playoff' ? cfg.playoffWeight : 1;
      const dA = cfg.K * mov * weight * (Sa - Ea);

      deltas[a] = (deltas[a] ?? 0) + dA;
      deltas[b] = (deltas[b] ?? 0) - dA;

      detail.push({ game: g, a, b, Ra, Rb, Ea, Eb, Sa, Sb, dA, mov, weight, margin });
    });

    detail.forEach(d => {
      const { game: g, a, b, Ra, Rb, Ea, Eb, Sa, Sb, dA, weight } = d;
      history[a].push({
        season: g.season, week: g.sortWeek, weekLabel: g.weekLabel,
        pointKey: `${g.season ?? 0}|${g.sortWeek}`,
        opponent: b, opponentLabel: labelOf(b),
        score: g.homeScore, oppScore: g.awayScore,
        result: Sa === 1 ? 'W' : Sa === 0 ? 'L' : 'T',
        before: Ra, after: Ra + dA, delta: dA,
        winProb: Ea, isPlayoff: g.isPlayoff, bracket: g.bracket, weight, seasonStart: false,
      });
      history[b].push({
        season: g.season, week: g.sortWeek, weekLabel: g.weekLabel,
        pointKey: `${g.season ?? 0}|${g.sortWeek}`,
        opponent: a, opponentLabel: labelOf(a),
        score: g.awayScore, oppScore: g.homeScore,
        result: Sb === 1 ? 'W' : Sb === 0 ? 'L' : 'T',
        before: Rb, after: Rb - dA, delta: -dA,
        winProb: Eb, isPlayoff: g.isPlayoff, bracket: g.bracket, weight, seasonStart: false,
      });
    });

    Object.keys(deltas).forEach(k => { ratings[k] = pre[k] + deltas[k]; });

    rounds.push({
      season: round_.season, week: round_.week, weekLabel: round_.weekLabel,
      key: round_.key,
      ratings: { ...ratings },
      games: detail.map(d => ({
        season: d.game.season, weekLabel: d.game.weekLabel,
        a: d.a, b: d.b, aLabel: labelOf(d.a), bLabel: labelOf(d.b),
        aScore: d.game.homeScore, bScore: d.game.awayScore,
        aBefore: d.Ra, bBefore: d.Rb, aDelta: d.dA, bDelta: -d.dA,
        aWinProb: d.Ea, isPlayoff: d.game.isPlayoff, bracket: d.game.bracket,
      })),
    });

    points.push({
      key: round_.key,
      label: carryover ? `'${String(round_.season).slice(2)} ${round_.weekLabel.replace('Wk ', 'W')}` : round_.weekLabel,
      season: round_.season, week: round_.week, type: 'game',
      isPlayoff: round_.games.some(g => g.isPlayoff),
    });
    snapshots.push({ ...ratings });
  });

  // Index-aligned chart series: entity → [rating at each point].
  // A manager's line only exists between their first and last game — before
  // they join the league (and after they leave it) the series is null so the
  // chart doesn't draw a phantom flat line at 1000.
  const series = {};
  Object.keys(ratings).forEach(k => {
    const raw = points.map((_, i) => {
      const snap = snapshots[i];
      return (snap && snap[k] !== undefined) ? snap[k] : null;
    });
    const playedKeys = new Set(
      (history[k] ?? []).filter(e => e.result === 'W' || e.result === 'L' || e.result === 'T').map(e => e.pointKey)
    );
    let firstIdx = -1, lastIdx = -1;
    points.forEach((p, i) => {
      if (!playedKeys.has(p.key)) return;
      if (firstIdx === -1) firstIdx = i;
      lastIdx = i;
    });
    series[k] = raw.map((v, i) => {
      if (firstIdx === -1) return null;
      // Anchor the line at `base` on the point immediately before the first game.
      if (i === firstIdx - 1) return cfg.base;
      if (i < firstIdx || i > lastIdx) return null;
      return v ?? cfg.base;
    });
  });
  // Per-point history entry lookup so chart tooltips can show the opponent.
  const entryAt = {};
  Object.keys(history).forEach(k => {
    entryAt[k] = {};
    history[k].forEach(e => { entryAt[k][e.pointKey] = e; });
  });

  // ── Per-entity summary ────────────────────────────────────────────────────
  const summary = Object.keys(ratings).map(k => {
    const h = history[k];
    const played = h.filter(e => e.result === 'W' || e.result === 'L' || e.result === 'T');
    let peak = { rating: cfg.base, at: null }, low = { rating: cfg.base, at: null };
    h.forEach(e => {
      if (e.after > peak.rating) peak = { rating: e.after, at: e };
      if (e.after < low.rating)  low  = { rating: e.after, at: e };
    });
    const gains = played.filter(e => e.delta > 0).sort((x, y) => y.delta - x.delta);
    const drops = played.filter(e => e.delta < 0).sort((x, y) => x.delta - y.delta);
    const wins = played.filter(e => e.result === 'W').length;
    const losses = played.filter(e => e.result === 'L').length;
    // Upsets: wins where the model gave you under 40% going in.
    const upsets = played.filter(e => e.result === 'W' && e.winProb != null && e.winProb < 0.40);
    return {
      key: k, label: labelOf(k),
      rating: ratings[k],
      games: played.length, wins, losses,
      peak: peak.at ? { rating: peak.rating, entry: peak.at } : { rating: cfg.base, entry: null },
      low:  low.at  ? { rating: low.rating,  entry: low.at  } : { rating: cfg.base, entry: null },
      bestGain: gains[0] ?? null,
      worstDrop: drops[0] ?? null,
      upsets: upsets.length,
      biggestUpset: upsets.sort((x, y) => x.winProb - y.winProb)[0] ?? null,
      history: h,
    };
  }).sort((a, b) => b.rating - a.rating).map((s, i) => ({ ...s, rank: i + 1 }));

  return { ratings, history, rounds, summary, points, series, entryAt, config: cfg };
}

/**
 * Season ELO — every team starts at 1000 on week 0 of this season.
 */
export function computeSeasonElo(schedule, teams, settings = {}, season = null) {
  const games = buildGamesFromSchedule(schedule, {
    regularSeasonWeeks: settings.regularSeasonWeeks ?? 14,
    combineWeeks: settings.combineWeeks ?? [[16, 17]],
    playoffTeamCount: settings.playoffTeamCount ?? 4,
    teams,
    season,
  });
  const nameById = Object.fromEntries(teams.map(t => [t.id, t.name]));
  const result = runElo(games, {
    entityOf: (g, side) => (side === 'home' ? g.homeId : g.awayId),
    labelOf: (id) => nameById[id] ?? `Team ${id}`,
    carryover: false,
  });
  // Make sure teams that never played still appear at base.
  teams.forEach(t => {
    if (result.ratings[t.id] === undefined) {
      result.ratings[t.id] = ELO_DEFAULTS.base;
      result.history[t.id] = [];
      result.series[t.id] = result.points.map(() => ELO_DEFAULTS.base);
      result.entryAt[t.id] = {};
    }
  });
  return result;
}

/**
 * Career ELO — one continuous rating per manager across all of league history.
 *
 * @param {Array} seasonsData  [{ season, teams, schedule, settings }] any order
 * @param {Function} normOwner  owner-name normaliser (alias map)
 */
export function computeCareerElo(seasonsData, normOwner = (x) => x, config = {}) {
  const ordered = [...seasonsData].sort((a, b) => a.season - b.season);
  const ownerByGameSide = new Map(); // gameRef → { home, away }
  const allGames = [];

  ordered.forEach(sd => {
    const owner = {};
    sd.teams.forEach(t => { owner[t.id] = normOwner(t.owner); });
    const games = buildGamesFromSchedule(sd.schedule, {
      regularSeasonWeeks: sd.settings?.regularSeasonWeeks ?? 14,
      combineWeeks: sd.settings?.combineWeeks ?? [[16, 17]],
      playoffTeamCount: sd.settings?.playoffTeamCount ?? 4,
      teams: sd.teams,
      season: sd.season,
    });
    games.forEach(g => {
      g._homeOwner = owner[g.homeId];
      g._awayOwner = owner[g.awayId];
      if (!g._homeOwner || !g._awayOwner) return;
      allGames.push(g);
    });
  });
  void ownerByGameSide;

  return runElo(allGames, {
    entityOf: (g, side) => (side === 'home' ? g._homeOwner : g._awayOwner),
    labelOf: (o) => o,
    carryover: true,
    config,
  });
}

/**
 * Flatten every game across all entities into one list, for league-wide
 * leaderboards (biggest swings, biggest upsets).
 */
export function allEloGames(result) {
  const out = [];
  result.rounds.forEach(r => r.games.forEach(g => out.push(g)));
  return out;
}
