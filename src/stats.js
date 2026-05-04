/**
 * Stats Engine
 *
 * Computes all derived stats that mirror the Excel spreadsheet:
 *  - Weekly scores per team
 *  - Head-to-head (single week + two-week rolling)
 *  - Expected Wins / Expected Losses (xW / xL) — formula: rank/(n-1) per week
 *  - Power Rankings (homemade xW-based)
 *  - Two-week rolling scores for h2h
 *  - Highest / Lowest week counts
 *  - Win above expected (W - xW)
 *  - Schedule Karma (luck score) — sums opponent over/underperformance vs their season avg
 */

// ─── Weekly Scores ────────────────────────────────────────────────────────────

/** Build a [teamId][week] → score lookup from schedule data. */
export function buildWeeklyScores(schedule, teams) {
  const scores = {};
  for (const team of teams) {
    scores[team.id] = {};
  }

  for (const matchups of Object.values(schedule)) {
    for (const matchup of matchups) {
      const week = matchup.week;
      if (matchup.homeTeamId) {
        scores[matchup.homeTeamId][week] = matchup.homeScore;
      }
      if (matchup.awayTeamId && !matchup.isBye) {
        scores[matchup.awayTeamId][week] = matchup.awayScore;
      }
    }
  }

  return scores;
}

/**
 * Return the list of completed regular-season weeks only.
 * Filters out playoff weeks so xW and related stats don't get inflated
 * by championship-round scoring.
 */
export function getCompletedWeeks(schedule, regularSeasonWeeks = 14) {
  return Object.keys(schedule)
    .map(Number)
    .filter(week => week <= regularSeasonWeeks)
    .filter(week => {
      const matchups = schedule[week];
      return matchups.some(m => m.homeScore > 0 || m.awayScore > 0);
    })
    .sort((a, b) => a - b);
}

/**
 * Return ALL completed weeks (regular season + playoffs), with consecutive
 * duplicate weeks removed. ESPN sometimes exposes a 2-week championship round
 * as two identical week entries — including both would double-count.
 */
export function getAllCompletedWeeks(schedule) {
  return getWeekGroups(schedule).map(group => group.canonicalWeek);
}

/**
 * Group consecutive weeks into logical "week groups" — used for 2-week
 * playoff matchups where two NFL weeks count as a single fantasy game.
 *
 * Two ways to group:
 *   1) Pass an explicit combineWeeks config like [[15, 16]] — these weeks
 *      are forced into a single combined group (the LATER week is canonical
 *      because it carries the cumulative ESPN score).
 *   2) Otherwise fall back to fingerprint detection (consecutive identical
 *      weeks get auto-grouped — handles ESPN's duplicate-week quirk).
 *
 * Returns an array of objects like:
 *   { weeks: [15, 16], canonicalWeek: 16, label: "Wks 15-16", combined: true }
 *
 * For stats (xW, wins, etc.) every group counts as ONE game using canonicalWeek.
 * For UI display, the group's weeks array lets us offer per-week lineup toggles.
 */
export function getWeekGroups(schedule, opts = {}) {
  const { combineWeeks = [] } = opts;

  // Build a map of week → group-id for short-circuit to explicit grouping
  const explicitGroupOf = {};
  const explicitGroups = [];
  combineWeeks.forEach((weekArray, groupId) => {
    explicitGroups.push({ id: groupId, weeks: [...weekArray].sort((a, b) => a - b) });
    weekArray.forEach(week => {
      explicitGroupOf[week] = groupId;
    });
  });

  // Find all weeks that have at least one matchup with a nonzero score
  const allPlayedWeeks = Object.keys(schedule)
    .map(Number)
    .filter(week => {
      const matchups = schedule[week];
      return matchups.some(m => m.homeScore > 0 || m.awayScore > 0);
    })
    .sort((a, b) => a - b);

  // Fingerprint function: produces a unique string for a week's matchup data
  const matchupKey = m =>
    `${m.homeTeamId}-${m.awayTeamId}-${(m.homeScore || 0).toFixed(2)}-${(m.awayScore || 0).toFixed(2)}`;
  const fingerprint = week =>
    (schedule[week] ?? []).map(matchupKey).sort().join('|');

  const groups = [];
  const seenExplicit = new Set();

  for (const week of allPlayedWeeks) {
    // Is this week part of an explicit combined group?
    if (explicitGroupOf[week] !== undefined) {
      const groupId = explicitGroupOf[week];
      if (seenExplicit.has(groupId)) continue;
      seenExplicit.add(groupId);

      const memberWeeks = explicitGroups[groupId].weeks.filter(w => allPlayedWeeks.includes(w));
      if (!memberWeeks.length) continue;

      const canonical = memberWeeks[memberWeeks.length - 1]; // latest = cumulative
      const label = memberWeeks.length === 1
        ? `Wk ${memberWeeks[0]}`
        : `Wks ${memberWeeks[0]}-${memberWeeks[memberWeeks.length - 1]}`;

      groups.push({
        weeks: memberWeeks,
        canonicalWeek: canonical,
        label,
        combined: memberWeeks.length > 1,
        fp: fingerprint(canonical),
        combinedExplicit: true,
      });
      continue;
    }

    // Fingerprint-based fallback for weeks NOT in an explicit group.
    // Auto-merges only when consecutive weeks have identical data — this handles
    // ESPN's duplicate-week quirk. Explicit groups always take precedence.
    const fp = fingerprint(week);
    const lastGroup = groups[groups.length - 1];

    if (lastGroup && lastGroup.fp === fp && !lastGroup.combinedExplicit) {
      lastGroup.weeks.push(week);
      lastGroup.label = `Wks ${lastGroup.weeks[0]}-${lastGroup.weeks[lastGroup.weeks.length - 1]}`;
      lastGroup.combined = true;
    } else {
      groups.push({
        weeks: [week],
        fp,
        label: `Wk ${week}`,
        canonicalWeek: week,
        combined: false,
      });
    }
  }

  groups.sort((a, b) => a.canonicalWeek - b.canonicalWeek);
  return groups;
}

/**
 * Per-week min/max score across the league (for the Weekly Scores extremes overlay).
 */
export function getWeeklyMinMax(weeklyScores, teams, weekList) {
  const meta = {};

  for (const week of weekList) {
    const values = teams
      .map(team => weeklyScores[team.id]?.[week] ?? 0)
      .filter(v => v > 0);

    meta[week] = {
      max: values.length ? Math.max(...values) : 0,
      min: values.length ? Math.min(...values) : 0,
    };
  }

  return meta;
}

// ─── Scaled Expected Wins (linear interpolation within each week's range) ─────

/**
 * Scaled Expected Wins — for each week group, each team's xW contribution is
 * (score - weekMin) / (weekMax - weekMin), placing them proportionally between
 * the lowest scorer (0) and highest scorer (1). Sums across all week groups.
 *
 * This produces better separation than Pythagorean and naturally reflects
 * how dominant a team's score was relative to the field each week.
 *
 * Returns:
 *   xW          = { teamId: total cumulative xW }
 *   xWByWeek    = { teamId: { canonicalWeek: xW earned that group } }
 *   xWCumByWeek = { teamId: { canonicalWeek: cumulative xW through this group } }
 */
export function computePythagoreanXW(teams, schedule, weekGroups) {
  const xW = {};
  const xWByWeek = {};
  const xWCumByWeek = {};

  for (const team of teams) {
    xW[team.id] = 0;
    xWByWeek[team.id] = {};
    xWCumByWeek[team.id] = {};
  }

  for (const group of weekGroups) {
    const matchups = getGroupMatchups(schedule, group);

    // Build team scores for this group (sum across all weeks in the group)
    const teamScores = {};
    for (const team of teams) {
      teamScores[team.id] = 0;
    }
    for (const matchup of matchups) {
      if (matchup.isBye) continue;
      if (matchup.homeTeamId != null) teamScores[matchup.homeTeamId] += matchup.homeScore;
      if (matchup.awayTeamId != null) teamScores[matchup.awayTeamId] += matchup.awayScore;
    }

    const values = teams.map(team => teamScores[team.id]).filter(v => v > 0);
    if (!values.length) continue;

    const weekMax = Math.max(...values);
    const weekMin = Math.min(...values);
    const range = weekMax - weekMin;

    for (const team of teams) {
      const score = teamScores[team.id];
      let weekXW = 0;
      if (score > 0) {
        weekXW = range > 0 ? (score - weekMin) / range : 0.5;
      }
      xW[team.id] += weekXW;
      xWByWeek[team.id][group.canonicalWeek] = weekXW;
      xWCumByWeek[team.id][group.canonicalWeek] = xW[team.id];
    }
  }

  return { xW, xWByWeek, xWCumByWeek };
}

/**
 * Return the matchups for a week group with scores SUMMED across all weeks
 * in the group. For standalone groups, returns the matchups as-is. For
 * combined groups (e.g. Wks 16-17), produces virtual matchup rows whose
 * homeScore/awayScore are the cumulative across the group's weeks.
 */
export function getGroupMatchups(schedule, group) {
  if (!group.combined || group.weeks.length <= 1) {
    return schedule[group.canonicalWeek] ?? [];
  }

  const baseMatchups = schedule[group.weeks[0]] ?? [];

  return baseMatchups.map(base => {
    let homeTotal = 0;
    let awayTotal = 0;

    for (const week of group.weeks) {
      const weekMatchup = (schedule[week] ?? []).find(m =>
        m.homeTeamId === base.homeTeamId && m.awayTeamId === base.awayTeamId
      );
      if (weekMatchup) {
        homeTotal += (weekMatchup.homeScore || 0);
        awayTotal += (weekMatchup.awayScore || 0);
      }
    }

    return { ...base, homeScore: round2(homeTotal), awayScore: round2(awayTotal) };
  });
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

/**
 * Count actual wins per team across week groups (each group = 1 game).
 */
export function countActualWinsByGroup(schedule, teams, weekGroups) {
  const wins = {};
  for (const team of teams) {
    wins[team.id] = 0;
  }

  for (const group of weekGroups) {
    const matchups = getGroupMatchups(schedule, group);
    for (const matchup of matchups) {
      if (matchup.isBye) continue;
      if (matchup.homeScore > matchup.awayScore) {
        wins[matchup.homeTeamId] = (wins[matchup.homeTeamId] ?? 0) + 1;
      } else if (matchup.awayScore > matchup.homeScore) {
        wins[matchup.awayTeamId] = (wins[matchup.awayTeamId] ?? 0) + 1;
      }
    }
  }

  return wins;
}

// ─── Expected Wins (xW) ───────────────────────────────────────────────────────

/**
 * For each week, each team's expected wins = rank/(n-1) where rank is
 * 0 (lowest) to n-1 (highest). This is the standard "all-play" model.
 *
 * Returns:
 *   xW          = { teamId: cumulative xW across season }
 *   xWByWeek    = { teamId: { week: xW that week } }
 *   xWCumByWeek = { teamId: { week: cumulative xW through that week } }
 */
export function computeExpectedWins(weeklyScores, teams, completedWeeks) {
  const xW = {};
  const xWByWeek = {};
  const xWCumByWeek = {};

  for (const team of teams) {
    xW[team.id] = 0;
    xWByWeek[team.id] = {};
    xWCumByWeek[team.id] = {};
  }

  for (const week of completedWeeks) {
    // Rank all teams by their score this week (ascending)
    const ranked = teams
      .map(team => ({ id: team.id, score: weeklyScores[team.id]?.[week] ?? 0 }))
      .sort((a, b) => a.score - b.score);

    const numTeams = ranked.length;
    ranked.forEach((entry, rank) => {
      const weekXW = rank / (numTeams - 1);
      xW[entry.id] += weekXW;
      xWByWeek[entry.id][week] = weekXW;
      xWCumByWeek[entry.id][week] = xW[entry.id];
    });
  }

  return { xW, xWByWeek, xWCumByWeek };
}

// ─── Two-Week Rolling Scores ──────────────────────────────────────────────────

export function computeBiweeklyScores(weeklyScores, teams, completedWeeks) {
  const biweekly = {};
  for (const team of teams) {
    biweekly[team.id] = {};
  }

  for (let i = 1; i < completedWeeks.length; i++) {
    const prevWeek = completedWeeks[i - 1];
    const currWeek = completedWeeks[i];
    for (const team of teams) {
      biweekly[team.id][currWeek] =
        (weeklyScores[team.id]?.[prevWeek] ?? 0) + (weeklyScores[team.id]?.[currWeek] ?? 0);
    }
  }

  return biweekly;
}

// ─── Head-to-Head Records ─────────────────────────────────────────────────────

export function computeH2HRecords(weeklyScores, teams, completedWeeks) {
  const h2h = {};
  const key = (a, b) => [a, b].sort().join("_");

  // Initialize all pairings
  for (const teamA of teams) {
    for (const teamB of teams) {
      if (teamA.id >= teamB.id) continue;
      h2h[key(teamA.id, teamB.id)] = { [teamA.id]: 0, [teamB.id]: 0 };
    }
  }

  // Count wins: compare every team pair's score each week
  for (const week of completedWeeks) {
    for (const teamA of teams) {
      for (const teamB of teams) {
        if (teamA.id >= teamB.id) continue;
        const k = key(teamA.id, teamB.id);
        const scoreA = weeklyScores[teamA.id]?.[week] ?? 0;
        const scoreB = weeklyScores[teamB.id]?.[week] ?? 0;
        if (scoreA > scoreB) h2h[k][teamA.id]++;
        else if (scoreB > scoreA) h2h[k][teamB.id]++;
      }
    }
  }

  return h2h;
}

// ─── Weekly Score Streaks / Extremes ─────────────────────────────────────────

/**
 * Single-week and 2-week extremes covering the FULL season.
 *
 * - Single-week extremes use weekGroups so a combined group (e.g. Wks 16-17)
 *   counts as ONE game with its summed cumulative score.
 * - Biweekly extremes use ALL individual played weeks so every consecutive
 *   pair is evaluated, including pairs that straddle playoffs.
 */
export function computeWeeklyExtremes(weeklyScores, biweeklyScores, teams, completedWeeks, weekGroups, allWeeks) {
  const highWeek = {};
  const lowWeek = {};
  const highBiweek = {};
  const lowBiweek = {};

  for (const team of teams) {
    highWeek[team.id] = 0;
    lowWeek[team.id] = 0;
    highBiweek[team.id] = 0;
    lowBiweek[team.id] = 0;
  }

  // Single-week extremes — iterate weekGroups (combined groups count as 1 game)
  const groups = (weekGroups && weekGroups.length)
    ? weekGroups
    : completedWeeks.map(w => ({ canonicalWeek: w, weeks: [w], combined: false }));

  for (const group of groups) {
    const scores = teams.map(team => ({
      id: team.id,
      score: group.weeks.reduce((sum, week) => sum + (weeklyScores[team.id]?.[week] ?? 0), 0),
    }));

    const nonZeroScores = scores.filter(s => s.score > 0);
    if (!nonZeroScores.length) continue;

    const maxScore = Math.max(...nonZeroScores.map(s => s.score));
    const minScore = Math.min(...nonZeroScores.map(s => s.score));

    for (const entry of scores) {
      if (entry.score === maxScore && entry.score > 0) highWeek[entry.id]++;
      if (entry.score === minScore && entry.score > 0) lowWeek[entry.id]++;
    }
  }

  // Biweekly extremes — iterate all individual weeks pairwise
  const weeksToWalk = (allWeeks && allWeeks.length) ? allWeeks : completedWeeks;

  for (let i = 1; i < weeksToWalk.length; i++) {
    const prevWeek = weeksToWalk[i - 1];
    const currWeek = weeksToWalk[i];

    const scores = teams.map(team => ({
      id: team.id,
      score: (weeklyScores[team.id]?.[prevWeek] ?? 0) + (weeklyScores[team.id]?.[currWeek] ?? 0),
    }));

    const nonZeroScores = scores.filter(s => s.score > 0);
    if (!nonZeroScores.length) continue;

    const maxScore = Math.max(...nonZeroScores.map(s => s.score));
    const minScore = Math.min(...nonZeroScores.map(s => s.score));

    for (const entry of scores) {
      if (entry.score === maxScore && entry.score > 0) highBiweek[entry.id]++;
      if (entry.score === minScore && entry.score > 0) lowBiweek[entry.id]++;
    }
  }

  return { highWeek, lowWeek, highBiweek, lowBiweek };
}

// ─── Power Rankings ───────────────────────────────────────────────────────────

export function computePowerRankings(teams, xW, completedWeeks) {
  const numWeeks = completedWeeks.length;
  return teams
    .map(team => ({
      team,
      xW: xW[team.id] ?? 0,
      xL: numWeeks - (xW[team.id] ?? 0),
    }))
    .sort((a, b) => b.xW - a.xW)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}

// ─── Season Summary ───────────────────────────────────────────────────────────

export function computeSeasonSummary(teams, weeklyScores, completedWeeks, xW, actualWins) {
  return teams.map(team => {
    const weekScores = completedWeeks.map(week => weeklyScores[team.id]?.[week] ?? 0);
    const totalPts = weekScores.reduce((sum, pts) => sum + pts, 0);
    const avgPts = weekScores.length ? totalPts / weekScores.length : 0;
    const teamXW = xW[team.id] ?? 0;
    const wins = actualWins[team.id] ?? team.wins;

    return {
      team,
      totalPts,
      avgPts,
      wins,
      losses: completedWeeks.length - wins,
      xW: teamXW,
      xL: completedWeeks.length - teamXW,
      winAboveExpected: wins - teamXW,
      weeklyScores: Object.fromEntries(
        completedWeeks.map(week => [week, weeklyScores[team.id]?.[week] ?? 0])
      ),
    };
  });
}

// ─── Actual Wins from Schedule ────────────────────────────────────────────────

/** Count actual wins for each team — REGULAR SEASON only (uses completedWeeks). */
export function countActualWins(schedule, teams, completedWeeks) {
  const wins = {};
  for (const team of teams) {
    wins[team.id] = 0;
  }

  for (const week of completedWeeks) {
    for (const matchup of (schedule[week] ?? [])) {
      if (matchup.isBye) continue;
      if (matchup.homeScore > matchup.awayScore) {
        wins[matchup.homeTeamId] = (wins[matchup.homeTeamId] ?? 0) + 1;
      } else if (matchup.awayScore > matchup.homeScore) {
        wins[matchup.awayTeamId] = (wins[matchup.awayTeamId] ?? 0) + 1;
      }
    }
  }

  return wins;
}

// ─── Schedule Karma (luck metric) ─────────────────────────────────────────────

/**
 * Schedule Karma — measures how lucky/unlucky your matchup schedule was
 * by tracking how much your opponents over/underperformed their season average.
 *
 * For each completed week:
 *   opponent_delta = opponent_avg_score - opponent_actual_score
 *   Positive = opponent had a BAD day vs their normal = you got LUCKY
 *   Negative = opponent had a HUGE day = you got UNLUCKY
 *
 * Result is the season total in points.
 */
export function computeScheduleKarma(schedule, weeklyScores, teams, completedWeeks, opts = {}) {
  // Z-score threshold — opponent must be more than this many standard deviations
  // from their own season mean to count as lucky-win / heartbreak-loss.
  const Z_THRESHOLD = opts.zThreshold ?? 1.0;

  // Compute each team's mean and standard deviation of weekly scores
  const avgScore = {};
  const stdScore = {};

  for (const team of teams) {
    const scores = completedWeeks
      .map(week => weeklyScores[team.id]?.[week] ?? 0)
      .filter(v => v > 0);

    const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const variance = scores.length
      ? scores.reduce((sum, val) => sum + (val - mean) ** 2, 0) / scores.length
      : 0;

    avgScore[team.id] = mean;
    stdScore[team.id] = Math.sqrt(variance);
  }

  const karma = {};
  const luckyWins = {};
  const heartbreakers = {};
  const totalGames = {};

  for (const team of teams) {
    karma[team.id] = 0;
    luckyWins[team.id] = 0;
    heartbreakers[team.id] = 0;
    totalGames[team.id] = 0;
  }

  // Per-team per-week breakdown for the expandable detail view
  const perWeek = {};
  for (const team of teams) {
    perWeek[team.id] = [];
  }

  for (const week of completedWeeks) {
    for (const matchup of (schedule[week] ?? [])) {
      if (matchup.isBye) continue;

      const homeId = matchup.homeTeamId;
      const awayId = matchup.awayTeamId;
      if (!homeId || !awayId) continue;

      // How much did each team's opponent deviate from their average?
      const oppDeltaForHome = avgScore[awayId] - matchup.awayScore;
      const oppDeltaForAway = avgScore[homeId] - matchup.homeScore;

      // Z-scores: how many stdev above/below their mean did each team score?
      const zAway = stdScore[awayId] > 0
        ? (matchup.awayScore - avgScore[awayId]) / stdScore[awayId]
        : 0;
      const zHome = stdScore[homeId] > 0
        ? (matchup.homeScore - avgScore[homeId]) / stdScore[homeId]
        : 0;

      karma[homeId] += oppDeltaForHome;
      karma[awayId] += oppDeltaForAway;
      totalGames[homeId]++;
      totalGames[awayId]++;

      const homeWon = matchup.homeScore > matchup.awayScore;
      const awayWon = matchup.awayScore > matchup.homeScore;

      // Lucky win: I won AND opponent had a statistically bad day (z < -threshold)
      if (homeWon && zAway < -Z_THRESHOLD) luckyWins[homeId]++;
      if (awayWon && zHome < -Z_THRESHOLD) luckyWins[awayId]++;

      // Heartbreak loss: I lost AND opponent had a statistically great day (z > +threshold)
      if (awayWon && zAway > Z_THRESHOLD) heartbreakers[homeId]++;
      if (homeWon && zHome > Z_THRESHOLD) heartbreakers[awayId]++;

      perWeek[homeId].push({
        week,
        oppId: awayId,
        myScore: matchup.homeScore,
        oppScore: matchup.awayScore,
        oppAvg: avgScore[awayId],
        oppStd: stdScore[awayId],
        oppZ: zAway,
        delta: oppDeltaForHome,
        won: homeWon,
        tied: !homeWon && !awayWon,
        wasLucky: homeWon && zAway < -Z_THRESHOLD,
        wasHeartbreak: awayWon && zAway > Z_THRESHOLD,
      });

      perWeek[awayId].push({
        week,
        oppId: homeId,
        myScore: matchup.awayScore,
        oppScore: matchup.homeScore,
        oppAvg: avgScore[homeId],
        oppStd: stdScore[homeId],
        oppZ: zHome,
        delta: oppDeltaForAway,
        won: awayWon,
        tied: !homeWon && !awayWon,
        wasLucky: awayWon && zHome < -Z_THRESHOLD,
        wasHeartbreak: homeWon && zHome > Z_THRESHOLD,
      });
    }
  }

  return { karma, luckyWins, heartbreakers, totalGames, avgScore, stdScore, perWeek, zThreshold: Z_THRESHOLD };
}

// ─── Playoff Bracket Logic ────────────────────────────────────────────────────

/**
 * Playoff record from a list of week groups (e.g., only the playoff groups).
 * Returns { teamId: { wins, losses } }
 */
export function playoffRecordByGroup(schedule, teams, playoffGroups) {
  const records = {};
  for (const team of teams) {
    records[team.id] = { wins: 0, losses: 0 };
  }

  for (const group of playoffGroups) {
    for (const matchup of getGroupMatchups(schedule, group)) {
      if (matchup.isBye) continue;
      if (matchup.homeScore > matchup.awayScore) {
        records[matchup.homeTeamId].wins++;
        if (matchup.awayTeamId) records[matchup.awayTeamId].losses++;
      } else if (matchup.awayScore > matchup.homeScore) {
        records[matchup.awayTeamId].wins++;
        if (matchup.homeTeamId) records[matchup.homeTeamId].losses++;
      }
    }
  }

  return records;
}

/**
 * 2-week rolling H2H records.
 * Returns { "idA_idB": { teamA: wins, teamB: wins } }
 */
export function compute2WkH2H(teams, biweeklyScores, completedWeeks) {
  const key = (a, b) => [a, b].sort().join('_');
  const records = {};

  for (const teamA of teams) {
    for (const teamB of teams) {
      if (teamA.id >= teamB.id) continue;
      records[key(teamA.id, teamB.id)] = { [teamA.id]: 0, [teamB.id]: 0 };
    }
  }

  const biweeks = completedWeeks.slice(1);
  for (const week of biweeks) {
    for (const teamA of teams) {
      for (const teamB of teams) {
        if (teamA.id >= teamB.id) continue;
        const k = key(teamA.id, teamB.id);
        const scoreA = biweeklyScores[teamA.id]?.[week] ?? 0;
        const scoreB = biweeklyScores[teamB.id]?.[week] ?? 0;
        if (scoreA > scoreB) records[k][teamA.id]++;
        else if (scoreB > scoreA) records[k][teamB.id]++;
      }
    }
  }

  return records;
}

/**
 * Tiebreaker-aware predictor for a single matchup.
 * Order: 2-week rolling H2H → direct H2H → season PF
 */
export function predictMatchupWinner(teamA, teamB, ctx) {
  const { h2h2wk, h2hReal, pf } = ctx;
  const key = [teamA.id, teamB.id].sort().join('_');

  // Tiebreaker 1: 2-week rolling H2H
  const rolling = h2h2wk[key] || {};
  const aRolling = rolling[teamA.id] ?? 0;
  const bRolling = rolling[teamB.id] ?? 0;
  if (aRolling !== bRolling) {
    return {
      winner: aRolling > bRolling ? teamA.id : teamB.id,
      reason: `2-wk H2H ${aRolling}-${bRolling}`,
    };
  }

  // Tiebreaker 2: direct H2H record
  const direct = h2hReal[key] || {};
  const aDirect = direct[teamA.id] ?? 0;
  const bDirect = direct[teamB.id] ?? 0;
  if (aDirect !== bDirect) {
    return {
      winner: aDirect > bDirect ? teamA.id : teamB.id,
      reason: `direct H2H ${aDirect}-${bDirect}`,
    };
  }

  // Tiebreaker 3: total points for
  const pfA = pf[teamA.id] ?? 0;
  const pfB = pf[teamB.id] ?? 0;
  return {
    winner: pfA >= pfB ? teamA.id : teamB.id,
    reason: `PF tiebreaker ${pfA.toFixed(1)} vs ${pfB.toFixed(1)}`,
  };
}

/**
 * Build the predicted playoff + consolation bracket.
 * seeded is teams sorted by current standings (top to bottom).
 *
 * Returns { playoff: {...}, consolation: {...} } where each is a 4-team bracket
 * with round1, final, and thirdGame.
 */
export function buildPredictedBracket(seeded, ctx) {
  const top4 = seeded.slice(0, 4);
  const bot4 = seeded.slice(4, 8);

  function buildSide(teamsBySeed, kind) {
    // Round 1 pairings:
    //   Playoff: classic top-vs-bottom (1v4, 2v3)
    //   Consolation: lowest-seeds-together (5v6, 7v8)
    let matchup1, matchup2;
    if (kind === 'consolation') {
      matchup1 = { seedA: 5, seedB: 6, a: teamsBySeed[0], b: teamsBySeed[1] };
      matchup2 = { seedA: 7, seedB: 8, a: teamsBySeed[2], b: teamsBySeed[3] };
    } else {
      matchup1 = { seedA: 1, seedB: 4, a: teamsBySeed[0], b: teamsBySeed[3] };
      matchup2 = { seedA: 2, seedB: 3, a: teamsBySeed[1], b: teamsBySeed[2] };
    }

    const round1Results = [matchup1, matchup2].map(pairing => {
      const result = predictMatchupWinner(pairing.a, pairing.b, ctx);
      return {
        ...pairing,
        ...result,
        winnerTeam: result.winner === pairing.a.id ? pairing.a : pairing.b,
        loserTeam: result.winner === pairing.a.id ? pairing.b : pairing.a,
      };
    });

    // Championship/5th-place final
    const finalistA = round1Results[0].winnerTeam;
    const finalistB = round1Results[1].winnerTeam;
    const finalResult = predictMatchupWinner(finalistA, finalistB, ctx);
    const final = {
      a: finalistA,
      b: finalistB,
      ...finalResult,
      winnerTeam: finalResult.winner === finalistA.id ? finalistA : finalistB,
      loserTeam: finalResult.winner === finalistA.id ? finalistB : finalistA,
    };

    // 3rd/7th place game
    const thirdA = round1Results[0].loserTeam;
    const thirdB = round1Results[1].loserTeam;
    const thirdResult = predictMatchupWinner(thirdA, thirdB, ctx);
    const thirdGame = {
      a: thirdA,
      b: thirdB,
      ...thirdResult,
      winnerTeam: thirdResult.winner === thirdA.id ? thirdA : thirdB,
      loserTeam: thirdResult.winner === thirdA.id ? thirdB : thirdA,
    };

    return { round1: round1Results, final, thirdGame, kind };
  }

  return {
    playoff: buildSide(top4, 'playoff'),
    consolation: buildSide(bot4, 'consolation'),
  };
}

/**
 * Resolve the ACTUAL playoff bracket from the schedule.
 * Assumes 8-team standard format: round 1 (4 matchups), then finals/3rd-place.
 *
 * Returns the same shape as buildPredictedBracket but with winners filled
 * by actual scores (not prediction).
 */
export function resolveActualBracket(schedule, weekGroups, teams, seeded, regWeeks) {
  const teamById = Object.fromEntries(teams.map(team => [team.id, team]));
  const effectiveRegWeeks = regWeeks ?? 14;

  // Find playoff groups: all groups whose canonicalWeek > regWeeks
  const playoffGroups = weekGroups.filter(group => group.canonicalWeek > effectiveRegWeeks);
  const round1Group = playoffGroups[0];
  const finalsGroup = playoffGroups[1];
  if (!round1Group || !finalsGroup) return null;

  const round1Matchups = getGroupMatchups(schedule, round1Group);
  const finalsMatchups = getGroupMatchups(schedule, finalsGroup);

  function wrapMatchup(teamA, teamB, matchup) {
    if (!matchup || !teamA || !teamB) return null;
    const aScore = matchup.homeTeamId === teamA.id ? matchup.homeScore : matchup.awayScore;
    const bScore = matchup.homeTeamId === teamA.id ? matchup.awayScore : matchup.homeScore;
    const winner = aScore > bScore ? teamA.id : (bScore > aScore ? teamB.id : null);
    return {
      a: teamA,
      b: teamB,
      winner,
      aScore,
      bScore,
      reason: `${aScore.toFixed(2)}–${bScore.toFixed(2)}`,
      winnerTeam: winner === teamA.id ? teamA : winner === teamB.id ? teamB : null,
      loserTeam: winner === teamA.id ? teamB : winner === teamB.id ? teamA : null,
    };
  }

  function findMatchupBetween(teamA, teamB, matchupList) {
    return matchupList.find(m =>
      (m.homeTeamId === teamA.id && m.awayTeamId === teamB.id) ||
      (m.homeTeamId === teamB.id && m.awayTeamId === teamA.id)
    );
  }

  // Standard method: find matchups within the top4/bot4 seed groups
  function roundOneWithinGroup(seedGroup) {
    const ids = new Set(seedGroup.map(team => team.id));
    return round1Matchups.filter(m => !m.isBye && ids.has(m.homeTeamId) && ids.has(m.awayTeamId));
  }

  const top4 = seeded.slice(0, 4);
  const bot4 = seeded.slice(4, 8);
  const top4Round1 = roundOneWithinGroup(top4);
  const bot4Round1 = roundOneWithinGroup(bot4);

  // Standard path: works when matchups stay within seed groups
  if (top4Round1.length >= 2 && bot4Round1.length >= 2) {
    function buildSide(groupTeams, r1Matchups, kind) {
      const teamObj = id => groupTeams.find(team => team.id === id);

      const game1 = wrapMatchup(teamObj(r1Matchups[0].homeTeamId), teamObj(r1Matchups[0].awayTeamId), r1Matchups[0]);
      const game2 = wrapMatchup(teamObj(r1Matchups[1].homeTeamId), teamObj(r1Matchups[1].awayTeamId), r1Matchups[1]);

      if (!game1 || !game2) {
        return { round1: [game1, game2].filter(Boolean), final: null, thirdGame: null, kind };
      }

      const finalsA = game1.winnerTeam;
      const finalsB = game2.winnerTeam;
      const thirdA = game1.loserTeam;
      const thirdB = game2.loserTeam;

      const finalGame = (finalsA && finalsB)
        ? wrapMatchup(finalsA, finalsB, findMatchupBetween(finalsA, finalsB, finalsMatchups))
        : null;
      const thirdGame = (thirdA && thirdB)
        ? wrapMatchup(thirdA, thirdB, findMatchupBetween(thirdA, thirdB, finalsMatchups))
        : null;

      return { round1: [game1, game2], final: finalGame, thirdGame, kind };
    }

    return {
      playoff: buildSide(top4, top4Round1, 'playoff'),
      consolation: buildSide(bot4, bot4Round1, 'consolation'),
    };
  }

  // Fallback: matchups cross seed groups (non-standard bracket formats)
  const validR1 = round1Matchups.filter(m => !m.isBye);
  const validFinals = finalsMatchups.filter(m => !m.isBye);
  if (validR1.length < 4 || validFinals.length < 4) return null;

  // Map each team to which R1 matchup they participated in
  const r1MatchupIndex = {};
  validR1.forEach((matchup, idx) => {
    r1MatchupIndex[matchup.homeTeamId] = idx;
    r1MatchupIndex[matchup.awayTeamId] = idx;
  });

  // Group R2 matchups by which R1 matchups their participants came from
  const r2Sources = {};
  validFinals.forEach((matchup, fnIdx) => {
    const sourceA = r1MatchupIndex[matchup.homeTeamId];
    const sourceB = r1MatchupIndex[matchup.awayTeamId];
    r2Sources[fnIdx] = new Set([sourceA, sourceB].filter(x => x !== undefined));
  });

  // Two R2 matchups are on the same "side" if they share the same R1 source matchups
  const sides = [];
  const usedR2 = new Set();

  for (let i = 0; i < validFinals.length; i++) {
    if (usedR2.has(i)) continue;
    for (let j = i + 1; j < validFinals.length; j++) {
      if (usedR2.has(j)) continue;
      const srcI = r2Sources[i];
      const srcJ = r2Sources[j];
      if (srcI.size === 2 && srcJ.size === 2 && [...srcI].every(x => srcJ.has(x))) {
        sides.push({ fnIndices: [i, j], r1Indices: [...srcI] });
        usedR2.add(i);
        usedR2.add(j);
        break;
      }
    }
  }

  if (sides.length < 2) return null;

  // Determine which side is "playoff" (higher seeds) vs "consolation"
  function sideAvgSeed(side) {
    const teamIds = new Set();
    side.r1Indices.forEach(idx => {
      teamIds.add(validR1[idx].homeTeamId);
      teamIds.add(validR1[idx].awayTeamId);
    });
    const seeds = [...teamIds].map(id => {
      const team = teams.find(t => t.id === id);
      return team?.playoffSeed ?? seeded.findIndex(s => s.id === id) + 1;
    });
    return seeds.reduce((a, b) => a + b, 0) / seeds.length;
  }

  sides.sort((a, b) => sideAvgSeed(a) - sideAvgSeed(b));

  function buildFallbackSide(side, kind) {
    const round1Games = side.r1Indices.map(idx => {
      const matchup = validR1[idx];
      return wrapMatchup(teamById[matchup.homeTeamId], teamById[matchup.awayTeamId], matchup);
    });

    // Identify final vs 3rd: final has both round-1 winners, 3rd has both losers
    const r1Winners = new Set(round1Games.filter(g => g).map(g => g.winner));
    let finalGame = null;
    let thirdGame = null;

    side.fnIndices.forEach(idx => {
      const matchup = validFinals[idx];
      const teamA = teamById[matchup.homeTeamId];
      const teamB = teamById[matchup.awayTeamId];
      const game = wrapMatchup(teamA, teamB, matchup);

      if (r1Winners.has(teamA?.id) && r1Winners.has(teamB?.id)) {
        finalGame = game;
      } else {
        thirdGame = game;
      }
    });

    return { round1: round1Games, final: finalGame, thirdGame, kind };
  }

  return {
    playoff: buildFallbackSide(sides[0], 'playoff'),
    consolation: buildFallbackSide(sides[1], 'consolation'),
  };
}

/**
 * Standings used for SEEDING the bracket — sorts by wins desc, then PF desc.
 */
export function seedingOrder(teams, seasonSummary) {
  return [...seasonSummary]
    .sort((a, b) => b.wins - a.wins || b.totalPts - a.totalPts)
    .map(entry => entry.team);
}

// ─── Touchdown totals per team ────────────────────────────────────────────────

/**
 * Sum each team's starter touchdowns (passing + rushing + receiving) across all
 * completed weeks. Only counts starters (skips bench/IR).
 */
export function computeTotalTouchdowns(schedule, teams, completedWeeks) {
  const totals = {};
  for (const team of teams) {
    totals[team.id] = 0;
  }

  const benchSlots = new Set(['BE', 'Bench', 'IR', 'IR/RES']);
  const touchdownPattern = /(touchdown|\btds?\b)/i;

  for (const week of completedWeeks) {
    for (const matchup of (schedule[week] ?? [])) {
      if (matchup.isBye) continue;

      const sides = [
        { teamId: matchup.homeTeamId, lineup: matchup.homeLineup },
        { teamId: matchup.awayTeamId, lineup: matchup.awayLineup },
      ];

      for (const { teamId, lineup } of sides) {
        if (!teamId || !lineup) continue;

        for (const player of lineup) {
          if (benchSlots.has(player.slot)) continue;

          const rawStats = player.rawStats || {};
          for (const [statKey, statValue] of Object.entries(rawStats)) {
            if (touchdownPattern.test(statKey)) {
              totals[teamId] += Number(statValue) || 0;
            }
          }
        }
      }
    }
  }

  // Round to integers (TDs are whole numbers)
  for (const key of Object.keys(totals)) {
    totals[key] = Math.round(totals[key]);
  }

  return totals;
}
