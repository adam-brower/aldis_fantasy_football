import { fetchLeagueData, fetchAvailableSeasons } from './espn-api.js';
import {
  buildWeeklyScores,
  getCompletedWeeks,
  getAllCompletedWeeks,
  getWeekGroups,
  getWeeklyMinMax,
  computeExpectedWins,
  computePythagoreanXW,
  computeBiweeklyScores,
  computeH2HRecords,
  computeWeeklyExtremes,
  computePowerRankings,
  computeSeasonSummary,
  countActualWins,
  countActualWinsByGroup,
  getGroupMatchups,
  playoffRecordByGroup,
  compute2WkH2H,
  buildPredictedBracket,
  resolveActualBracket,
  seedingOrder,
  computeTotalTouchdowns,
  computeScheduleKarma,
} from './stats.js';

// ── State ─────────────────────────────────────────────────────────────────────
let APP = {};
let currentMatchupWeek = null;
window._h2hMode = 'single';
window._fullH2HOpen = false;

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  try {
    const seasons = await fetchAvailableSeasons();
    buildSeasonSelector(seasons);
    const data = await fetchLeagueData(seasons[0]);
    await boot(data);
  } catch (err) {
    console.error(err);
    showError(err);
  }
})();

function buildSeasonSelector(seasons) {
  const container = document.getElementById('season-selector');
  if (!container) return;
  container.style.display = '';
  const seasonOpts = seasons.map(y => `<option value="${y}">${y}–${String(y+1).slice(2)}</option>`).join('');
  const allTimeOpt = seasons.length > 1 ? `<option value="alltime">All-Time</option>` : '';
  container.innerHTML = `<label for="season-select" style="font-size:.8rem;color:var(--text2);margin-right:.4rem">Select Year: </label><select id="season-select">${seasonOpts}${allTimeOpt}</select>`;
  document.getElementById('season-select').addEventListener('change', async (e) => {
    const val = e.target.value;
    document.getElementById('app').style.display = 'none';
    document.getElementById('app-alltime').style.display = 'none';
    document.getElementById('loading').style.display = '';
    setStatus('live', 'Loading…');
    try {
      if (val === 'alltime') {
        await bootAllTime(seasons);
      } else {
        const data = await fetchLeagueData(parseInt(val));
        await boot(data);
      }
    } catch (err) {
      console.error(err);
      showError(err);
    }
  });
}

async function boot(data) {
  const { teams, schedule, settings, powerRankings } = data;
  const regWeeks = settings?.regularSeasonWeeks ?? 14;

  const weeklyScores = buildWeeklyScores(schedule, teams);
  const completedWeeks = getCompletedWeeks(schedule, regWeeks);
  // Playoff structure varies by season — read from data settings, fallback to 2025 structure
  const combineWeeks = settings?.combineWeeks ?? [[16, 17]];
  const weekGroups     = getWeekGroups(schedule, { combineWeeks });
  const allCanonical   = weekGroups.map(g => g.canonicalWeek);

  const biweeklyScores = computeBiweeklyScores(weeklyScores, teams, completedWeeks);
  const { xW, xWByWeek, xWCumByWeek } = computeExpectedWins(weeklyScores, teams, completedWeeks);
  const h2hRecords = computeH2HRecords(weeklyScores, teams, completedWeeks);
  const actualWins = countActualWins(schedule, teams, completedWeeks);

  // Regular-season scaled xW for the default standings view (consistent with Power Rankings)
  const regGroups = completedWeeks.map(w => ({ canonicalWeek: w, weeks: [w], combined: false, label: `Wk ${w}` }));
  const regPyth = computePythagoreanXW(teams, schedule, regGroups);
  const seasonSummary = teams.map(t => {
    const pf = completedWeeks.reduce((s, w) => s + (weeklyScores[t.id]?.[w] ?? 0), 0);
    // Use stored wins (from ESPN or CSV) — more reliable than re-deriving from
    // schedule pairings which may be unavailable for historical seasons.
    const w = t.wins ?? (actualWins[t.id] ?? 0);
    const l = t.losses ?? (completedWeeks.length - w);
    return {
      team: t,
      totalPts: pf,
      avgPts: completedWeeks.length ? pf / completedWeeks.length : 0,
      wins: w,
      losses: l,
      xW: regPyth.xW[t.id] ?? 0,
      xL: completedWeeks.length - (regPyth.xW[t.id] ?? 0),
    };
  });
  const karma = computeScheduleKarma(schedule, weeklyScores, teams, completedWeeks);
  const weekMinMax = getWeeklyMinMax(weeklyScores, teams, allCanonical);

  // ── Full season scaled xW (treats Wks 16-17 as 1 game) for Power Rankings & full standings
  const pyth = computePythagoreanXW(teams, schedule, weekGroups);
  const actualWinsAll = countActualWinsByGroup(schedule, teams, weekGroups);
  const powerRanks = teams.map(t => ({
    team: t,
    xW: pyth.xW[t.id] ?? 0,
    xL: weekGroups.length - (pyth.xW[t.id] ?? 0),
  })).sort((a, b) => b.xW - a.xW).map((e, i) => ({ ...e, rank: i + 1 }));

  // For the standings playoff-include toggle, build a scaled-xW-based summary
  const seasonSummaryAll = teams.map(t => {
    // PF/PA across all week groups (uses cumulative for combined groups)
    let pf = 0, pa = 0;
    weekGroups.forEach(g => {
      getGroupMatchups(schedule, g).forEach(m => {
        if (m.isBye) return;
        if (m.homeTeamId === t.id) { pf += m.homeScore; pa += m.awayScore; }
        else if (m.awayTeamId === t.id) { pf += m.awayScore; pa += m.homeScore; }
      });
    });
    // Use stored totalWins/totalLosses for historical years (fake reg pairings make
    // schedule-derived wins unreliable), otherwise compute from actual matchup results
    const w = (t.totalWins != null) ? t.totalWins : (actualWinsAll[t.id] ?? 0);
    const l = (t.totalLosses != null) ? t.totalLosses : (weekGroups.length - w);
    return {
      team: t,
      totalPts: pf,
      pointsAgainstFull: pa,
      avgPts: weekGroups.length ? pf / weekGroups.length : 0,
      wins: w,
      losses: l,
      xW: pyth.xW[t.id] ?? 0,
      xL: weekGroups.length - (pyth.xW[t.id] ?? 0),
    };
  });

  // teamById lookup for matchup rendering
  const teamById = Object.fromEntries(teams.map(t => [t.id, t]));

  // Seeding for playoff matchup labeling and bracket prediction
  // Use stored playoffSeed if available (historical data), else derive from standings
  const hasExplicitSeeds = teams.some(t => t.playoffSeed > 0);
  const regSeed = hasExplicitSeeds
    ? [...teams].sort((a, b) => a.playoffSeed - b.playoffSeed)
    : seedingOrder(teams, seasonSummary);

  // 2-week rolling H2H — used for the playoff predictor's primary tiebreaker
  const h2h2wk = compute2WkH2H(teams, biweeklyScores, completedWeeks);

  // Build predicted bracket from regular-season-derived seeding + tiebreakers
  const pf = Object.fromEntries(seasonSummary.map(s => [s.team.id, s.totalPts]));
  const ctx = { h2h2wk, h2hReal: h2hRecords, pf };
  const predictedBracket = buildPredictedBracket(regSeed, ctx);
  // Actual bracket (only meaningful once playoffs have happened)
  const actualBracket = resolveActualBracket(schedule, weekGroups, teams, regSeed, regWeeks);

  // Trade data passed through from data.json
  const trades = data.trades ?? [];

  // Total starter touchdowns per team across the WHOLE season (incl. playoffs)
  const allWeeksWithData = Object.keys(schedule).map(Number).filter(w => {
    return (schedule[w] ?? []).some(m => m.homeScore > 0 || m.awayScore > 0);
  }).sort((a,b)=>a-b);
  const totalTDs = computeTotalTouchdowns(schedule, teams, allWeeksWithData);

  // Extremes across the FULL season (all weekGroups + all individual weeks for biweekly)
  const extremes = computeWeeklyExtremes(weeklyScores, biweeklyScores, teams, completedWeeks, weekGroups, allWeeksWithData);

  // Historical seasons lack real reg-season matchup data (2023, 2024 from different league)
  const currentSeason = new Date().getFullYear() - 1; // e.g. 2025 for the 2025-26 season
  const isHistorical = (data.meta?.season ?? currentSeason) < currentSeason;

  APP = { teams, teamById, schedule, settings, weeklyScores, biweeklyScores, completedWeeks,
          xW, xWByWeek, xWCumByWeek, h2hRecords, extremes, powerRanks, actualWins,
          seasonSummary, karma, powerRankings, regWeeks,
          weekGroups, allCanonical, weekMinMax,
          pyth, actualWinsAll, seasonSummaryAll,
          regSeed, h2h2wk, predictedBracket, actualBracket, trades,
          totalTDs, allWeeksWithData, isHistorical };

  renderStandings();
  renderWeeklyScores();

  // Hide matchups section for historical years (no real reg-season pairings)
  document.getElementById('sec-matchups').style.display = isHistorical ? 'none' : '';
  if (!isHistorical) renderMatchupSelector();

  // Hide H2H comparison for historical years
  document.getElementById('sec-h2h').style.display = isHistorical ? 'none' : '';
  if (!isHistorical) {
    renderH2H('single');
    renderH2H('biweek');
    renderCompareDropdowns();
  }

  renderPowerRankings();
  renderXWChart();
  renderESPNPowerChart();
  renderBracket();
  if (!isHistorical) renderTradeAnalyzer();
  document.getElementById('sec-trades').style.display = isHistorical ? 'none' : '';

  document.getElementById('loading').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.getElementById('app-alltime').style.display = 'none';

  const season = data.meta?.season ?? '';
  const seasonLabel = season ? `${season}–${String(season + 1).slice(2)}` : '';
  document.title = `Aldi's Fantasy Football${seasonLabel ? ' · ' + seasonLabel : ''}`;

  const lastUpdated = data.meta?.lastUpdated
    ? new Date(data.meta.lastUpdated).toLocaleDateString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })
    : `Week ${Math.max(...completedWeeks)}`;
  setStatus('live', `Updated ${lastUpdated}`);
}

// ── Status indicator ──────────────────────────────────────────────────────────
function setStatus(type, msg) {
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  dot.className = 'status-dot ' + type;
  txt.textContent = msg;
}

function showError(err) {
  document.getElementById('loading').style.display = 'none';
  const ep = document.getElementById('error-panel');
  ep.style.display = 'block';
  document.getElementById('error-msg').textContent = err.message;
  setStatus('error', 'Failed to load');
}

// ── All-Time View ─────────────────────────────────────────────────────────────
async function bootAllTime(seasons) {
  // Load all season data
  const allData = await Promise.all(seasons.map(y => fetchLeagueData(y)));

  // Normalize owner names across seasons
  const ownerAliases = {
    'Tom Gallagher': 'Thomas Gallagher',
    'Macks Weiser': 'Max Weiser',
    'Jake Kerstetter': 'Jacob Kerstetter',
  };
  const normOwner = (name) => ownerAliases[name] || name;

  // ── Aggregate data by owner ───────────────────────────────────────────────
  const ownerStats = {};  // { owner: { seasons, totalWins, totalLosses, totalPF, ... } }
  const allWeekScores = []; // { owner, team, season, week, score }
  const allMatchups = [];   // { season, week, homeOwner, awayOwner, homeScore, awayScore }
  const championships = []; // { season, champion, runnerUp, champScore, runnerUpScore }
  const finalStandings = []; // { season, standings: [{owner, place}] }

  allData.forEach((data, idx) => {
    const season = data.meta?.season ?? seasons[idx];
    const teams = data.teams;
    const schedule = data.schedule;
    const settings = data.settings;
    const regWeeks = settings?.regularSeasonWeeks ?? 14;
    const combineWeeks = settings?.combineWeeks ?? [[16,17]];

    // Team ID → owner for this season
    const teamOwner = {};
    const teamName = {};
    teams.forEach(t => {
      const owner = normOwner(t.owner);
      teamOwner[t.id] = owner;
      teamName[t.id] = t.name;
      if (!ownerStats[owner]) {
        ownerStats[owner] = {
          seasons: 0, totalWins: 0, totalLosses: 0, totalPF: 0,
          bestXW: null, championships: 0, runnerUps: 0,
          teamNames: new Set(), seasonResults: [],
        };
      }
    });

    // Count season stats — reg season wins from t.wins/t.losses
    teams.forEach(t => {
      const owner = normOwner(t.owner);
      ownerStats[owner].seasons++;
      ownerStats[owner].teamNames.add(t.name);
    });

    // Weekly scores (individual week entries for single-week records)
    const allWeeks = Object.keys(schedule).map(Number).sort((a,b)=>a-b);
    allWeeks.forEach(w => {
      (schedule[w] ?? []).forEach(m => {
        if (m.isBye) return;
        if (m.homeScore > 0) {
          const ho = teamOwner[m.homeTeamId];
          if (ho) allWeekScores.push({ owner: ho, team: teamName[m.homeTeamId], season, week: w, score: m.homeScore });
        }
        if (m.awayScore > 0) {
          const ao = teamOwner[m.awayTeamId];
          if (ao) allWeekScores.push({ owner: ao, team: teamName[m.awayTeamId], season, week: w, score: m.awayScore });
        }
      });
    });

    // Track matchups as GAMES (combined weeks count as 1 game)
    // Build week→group mapping from combineWeeks
    const weekToGroup = {}; // week → group index (or null for single weeks)
    combineWeeks.forEach((group, gi) => group.forEach(w => { weekToGroup[w] = gi; }));
    const processedGroups = new Set(); // track which combined groups we've already processed

    allWeeks.forEach(w => {
      const groupIdx = weekToGroup[w];
      if (groupIdx !== undefined) {
        // Combined week — only process once per group
        const groupKey = `${season}_${groupIdx}`;
        if (processedGroups.has(groupKey)) return;
        processedGroups.add(groupKey);
        const groupWeeks = combineWeeks[groupIdx];
        // Sum scores across all weeks in this group per matchup pairing
        const pairings = {}; // "homeId_awayId" → { homeScore, awayScore }
        groupWeeks.forEach(gw => {
          (schedule[gw] ?? []).forEach(m => {
            if (m.isBye) return;
            const pairKey = `${m.homeTeamId}_${m.awayTeamId}`;
            if (!pairings[pairKey]) pairings[pairKey] = { homeId: m.homeTeamId, awayId: m.awayTeamId, homeScore: 0, awayScore: 0 };
            pairings[pairKey].homeScore += m.homeScore;
            pairings[pairKey].awayScore += m.awayScore;
          });
        });
        Object.values(pairings).forEach(p => {
          const ho = teamOwner[p.homeId];
          const ao = teamOwner[p.awayId];
          if (ho && ao && p.homeScore > 0 && p.awayScore > 0) {
            allMatchups.push({ season, week: groupWeeks[0], weekLabel: `Wk ${groupWeeks.join('-')}`, homeOwner: ho, awayOwner: ao, homeScore: p.homeScore, awayScore: p.awayScore });
          }
        });
      } else {
        // Single week — each matchup is its own game
        (schedule[w] ?? []).forEach(m => {
          if (m.isBye) return;
          const ho = teamOwner[m.homeTeamId];
          const ao = teamOwner[m.awayTeamId];
          if (ho && ao && m.homeScore > 0 && m.awayScore > 0) {
            allMatchups.push({ season, week: w, weekLabel: `Wk ${w}`, homeOwner: ho, awayOwner: ao, homeScore: m.homeScore, awayScore: m.awayScore });
          }
        });
      }
    });

    // Total PF per owner
    teams.forEach(t => {
      const owner = normOwner(t.owner);
      // Sum from schedule for accuracy
      let pf = 0;
      allWeeks.forEach(w => {
        (schedule[w] ?? []).forEach(m => {
          if (m.homeTeamId === t.id) pf += m.homeScore;
          else if (m.awayTeamId === t.id) pf += m.awayScore;
        });
      });
      ownerStats[owner].totalPF += pf;
    });

    // Championship data from bracket
    const playoffWeeks = combineWeeks.flat();
    const lastRoundWeeks = combineWeeks[combineWeeks.length - 1];
    // Find championship matchup: in the final round weeks, look for it
    if (lastRoundWeeks) {
      const finalMatchups = (schedule[String(lastRoundWeeks[0])] ?? []);
      // The championship is between seeds 1-4 (top bracket winner vs winner)
      // We'll determine champion by finding the combined score winner in the final round
      // Determine top-4 playoff teams: use explicit playoffSeed if available,
      // otherwise derive from regular-season standings (wins then PF)
      const hasSeeds = teams.some(t => t.playoffSeed > 0);
      let topSeedIds;
      if (hasSeeds) {
        topSeedIds = new Set(teams.filter(t => t.playoffSeed >= 1 && t.playoffSeed <= 4).map(t => t.id));
      } else {
        const standingsOrder = [...teams].sort((a,b) => b.wins - a.wins || b.pointsFor - a.pointsFor);
        topSeedIds = new Set(standingsOrder.slice(0, 4).map(t => t.id));
      }

      // Find the final round matchup between top-4 teams
      let champMatch = null;
      for (const m of finalMatchups) {
        if (topSeedIds.has(m.homeTeamId) && topSeedIds.has(m.awayTeamId)) {
          // Combined score across all weeks in this round
          let hTotal = 0, aTotal = 0;
          lastRoundWeeks.forEach(rw => {
            (schedule[String(rw)] ?? []).forEach(rm => {
              if (rm.homeTeamId === m.homeTeamId && rm.awayTeamId === m.awayTeamId) {
                hTotal += rm.homeScore;
                aTotal += rm.awayScore;
              }
            });
          });
          champMatch = { homeId: m.homeTeamId, awayId: m.awayTeamId, homeTotal: hTotal, awayTotal: aTotal };
          break;
        }
      }
      if (champMatch) {
        const champId = champMatch.homeTotal > champMatch.awayTotal ? champMatch.homeId : champMatch.awayId;
        const runnerId = champId === champMatch.homeId ? champMatch.awayId : champMatch.homeId;
        const champOwner = teamOwner[champId];
        const runnerOwner = teamOwner[runnerId];
        const champScore = champId === champMatch.homeId ? champMatch.homeTotal : champMatch.awayTotal;
        const runnerScore = champId === champMatch.homeId ? champMatch.awayTotal : champMatch.homeTotal;
        championships.push({
          season, champion: champOwner, runnerUp: runnerOwner,
          champTeam: teamName[champId], runnerUpTeam: teamName[runnerId],
          champScore, runnerUpScore: runnerScore,
        });
        ownerStats[champOwner].championships++;
        ownerStats[runnerOwner].runnerUps++;
      }
    }

    // Season results for each owner
    const sorted = [...teams].sort((a,b) => b.wins - a.wins || b.pointsFor - a.pointsFor);
    sorted.forEach((t, i) => {
      ownerStats[normOwner(t.owner)].seasonResults.push({ season, place: i+1, wins: t.wins, losses: t.losses, team: t.name });
    });
  });

  // ── Compute derived stats ─────────────────────────────────────────────────

  // Compute total W/L: use stored totalWins/totalLosses for historical (fake reg matchups),
  // derive from actual game results for current-era seasons (2025+)
  allMatchups.forEach(m => {
    if (m.homeOwner === m.awayOwner) return;
    if (m.season < 2025) return; // skip historical fake reg-season matchups
    const winner = m.homeScore > m.awayScore ? m.homeOwner : m.awayOwner;
    const loser = m.homeScore > m.awayScore ? m.awayOwner : m.homeOwner;
    if (ownerStats[winner]) ownerStats[winner].totalWins++;
    if (ownerStats[loser]) ownerStats[loser].totalLosses++;
  });
  // Add historical totals from stored data
  allData.forEach((data, idx) => {
    const season = data.meta?.season ?? seasons[idx];
    if (season >= 2025) return; // already counted from matchups
    data.teams.forEach(t => {
      const owner = normOwner(t.owner);
      if (ownerStats[owner]) {
        ownerStats[owner].totalWins += t.totalWins ?? t.wins;
        ownerStats[owner].totalLosses += t.totalLosses ?? t.losses;
      }
    });
  });

  // Top single-week scores
  const topWeekScores = [...allWeekScores].sort((a,b) => b.score - a.score).slice(0, 10);
  const bottomWeekScores = [...allWeekScores].sort((a,b) => a.score - b.score).slice(0, 10);

  // Biggest blowouts (from real matchups only — 2025+ has real reg-season pairings)
  const realMatchups = allMatchups.filter(m => m.season >= 2025);
  const blowouts = realMatchups.map(m => ({
    ...m,
    margin: Math.abs(m.homeScore - m.awayScore),
    winner: m.homeScore > m.awayScore ? m.homeOwner : m.awayOwner,
    loser: m.homeScore > m.awayScore ? m.awayOwner : m.homeOwner,
    winScore: Math.max(m.homeScore, m.awayScore),
    loseScore: Math.min(m.homeScore, m.awayScore),
  })).sort((a,b) => b.margin - a.margin).slice(0, 10);

  // Closest games
  const closestGames = realMatchups
    .filter(m => m.homeOwner !== m.awayOwner)
    .map(m => ({
      ...m,
      margin: Math.abs(m.homeScore - m.awayScore),
      winner: m.homeScore > m.awayScore ? m.homeOwner : m.awayOwner,
      loser: m.homeScore > m.awayScore ? m.awayOwner : m.homeOwner,
      winScore: Math.max(m.homeScore, m.awayScore),
      loseScore: Math.min(m.homeScore, m.awayScore),
    })).sort((a,b) => a.margin - b.margin).slice(0, 10);

  // Highest combined score in a single matchup (exclude combined weeks)
  const highestCombined = realMatchups
    .filter(m => m.homeOwner !== m.awayOwner && !m.weekLabel.includes('-'))
    .map(m => ({ ...m, combined: m.homeScore + m.awayScore,
      winner: m.homeScore > m.awayScore ? m.homeOwner : m.awayOwner,
      loser: m.homeScore > m.awayScore ? m.awayOwner : m.homeOwner,
      winScore: Math.max(m.homeScore, m.awayScore),
      loseScore: Math.min(m.homeScore, m.awayScore),
    })).sort((a,b) => b.combined - a.combined).slice(0, 5);

  // Lowest combined score in a single matchup
  const lowestCombined = realMatchups
    .filter(m => m.homeOwner !== m.awayOwner)
    .map(m => ({ ...m, combined: m.homeScore + m.awayScore,
      winner: m.homeScore > m.awayScore ? m.homeOwner : m.awayOwner,
      loser: m.homeScore > m.awayScore ? m.awayOwner : m.homeOwner,
      winScore: Math.max(m.homeScore, m.awayScore),
      loseScore: Math.min(m.homeScore, m.awayScore),
    })).sort((a,b) => a.combined - b.combined).slice(0, 5);

  // Highest losing score (best score that still lost, exclude combined weeks)
  const highestLosing = realMatchups
    .filter(m => m.homeOwner !== m.awayOwner && !m.weekLabel.includes('-'))
    .map(m => ({
      ...m,
      loser: m.homeScore > m.awayScore ? m.awayOwner : m.homeOwner,
      loserScore: Math.min(m.homeScore, m.awayScore),
      winnerScore: Math.max(m.homeScore, m.awayScore),
    })).sort((a,b) => b.loserScore - a.loserScore).slice(0, 5);

  // Lowest winning score (worst score that still won)
  const lowestWinning = realMatchups
    .filter(m => m.homeOwner !== m.awayOwner)
    .map(m => ({
      ...m,
      winner: m.homeScore > m.awayScore ? m.homeOwner : m.awayOwner,
      winnerScore: Math.max(m.homeScore, m.awayScore),
      loserScore: Math.min(m.homeScore, m.awayScore),
    })).sort((a,b) => a.winnerScore - b.winnerScore).slice(0, 5);

  // Owner H2H — only from non-historical seasons (2025+)
  const h2hMatchups = allMatchups.filter(m => m.season >= 2025 && m.homeOwner !== m.awayOwner);
  const ownerH2H = {}; // { 'ownerA|||ownerB': { a: wins, b: wins, games: [...] } }
  h2hMatchups.forEach(m => {
    const key = [m.homeOwner, m.awayOwner].sort().join('|||');
    if (!ownerH2H[key]) ownerH2H[key] = { games: [] };
    const winner = m.homeScore > m.awayScore ? m.homeOwner : m.awayOwner;
    ownerH2H[key][winner] = (ownerH2H[key][winner] ?? 0) + 1;
    ownerH2H[key].games.push(m);
  });

  // Win streaks and losing streaks per owner (2025+ real matchups only)
  const ownerWeekResults = {}; // { owner: [{season, week, won}] }
  realMatchups.forEach(m => {
    if (m.homeOwner === m.awayOwner) return;
    const hWon = m.homeScore > m.awayScore;
    if (!ownerWeekResults[m.homeOwner]) ownerWeekResults[m.homeOwner] = [];
    if (!ownerWeekResults[m.awayOwner]) ownerWeekResults[m.awayOwner] = [];
    ownerWeekResults[m.homeOwner].push({ season: m.season, week: m.week, won: hWon });
    ownerWeekResults[m.awayOwner].push({ season: m.season, week: m.week, won: !hWon });
  });

  function longestStreak(results, val) {
    let max = 0, cur = 0, startSeason = null, startWeek = null, bestStart = null, bestEnd = null;
    results.sort((a,b) => a.season - b.season || a.week - b.week);
    results.forEach((r, i) => {
      if (r.won === val) {
        if (cur === 0) { startSeason = r.season; startWeek = r.week; }
        cur++;
        if (cur > max) { max = cur; bestStart = { season: startSeason, week: startWeek }; bestEnd = { season: r.season, week: r.week }; }
      } else { cur = 0; }
    });
    return { length: max, start: bestStart, end: bestEnd };
  }

  const winStreaks = Object.entries(ownerWeekResults).map(([owner, results]) => ({
    owner, ...longestStreak(results, true),
  })).sort((a,b) => b.length - a.length);

  const loseStreaks = Object.entries(ownerWeekResults).map(([owner, results]) => ({
    owner, ...longestStreak(results, false),
  })).sort((a,b) => b.length - a.length);

  // Highest scoring seasons
  const ownerSeasonPF = [];
  allData.forEach((data, idx) => {
    const season = data.meta?.season ?? seasons[idx];
    data.teams.forEach(t => {
      ownerSeasonPF.push({ owner: normOwner(t.owner), team: t.name, season, pf: t.pointsFor });
    });
  });
  ownerSeasonPF.sort((a,b) => b.pf - a.pf);

  // ── RENDER ────────────────────────────────────────────────────────────────

  // Season Records card
  const ownerArr = Object.entries(ownerStats).sort((a,b) => b[1].totalWins - a[1].totalWins);
  document.getElementById('alltime-season-records').innerHTML = `
    <div class="card-title">Career Leaderboard</div>
    <table style="width:100%;border-collapse:collapse;font-size:.82rem">
      <thead><tr style="border-bottom:1px solid var(--border);color:var(--text3);font-size:.7rem;text-transform:uppercase;letter-spacing:1px">
        <th style="text-align:left;padding:.4rem">Owner</th>
        <th>Seasons</th><th>W</th><th>L</th><th>W%</th><th>Total PF</th><th>🏆</th>
      </tr></thead>
      <tbody>${ownerArr.map(([owner, s]) => {
        const pct = (s.totalWins + s.totalLosses) > 0 ? (s.totalWins / (s.totalWins + s.totalLosses) * 100).toFixed(1) : '—';
        return `<tr style="border-bottom:1px solid var(--border)">
          <td style="padding:.4rem;font-weight:600">${esc(owner)}</td>
          <td class="center">${s.seasons}</td>
          <td class="center">${s.totalWins}</td>
          <td class="center">${s.totalLosses}</td>
          <td class="center">${pct}%</td>
          <td class="center">${s.totalPF.toFixed(0)}</td>
          <td class="center">${s.championships > 0 ? '🏆'.repeat(s.championships) : '—'}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>
    <div style="margin-top:1rem;font-size:.72rem;color:var(--text3)">
      <strong>Highest Scoring Season:</strong> ${ownerSeasonPF[0]?.owner} — ${ownerSeasonPF[0]?.pf.toFixed(2)} PF (${ownerSeasonPF[0]?.season}–${String((ownerSeasonPF[0]?.season??0)+1).slice(2)}, "${ownerSeasonPF[0]?.team}")
    </div>`;

  // Championships card
  document.getElementById('alltime-championships').innerHTML = `
    <div class="card-title">🏆 Championship History</div>
    ${championships.length === 0 ? '<div style="color:var(--text3);padding:1rem">No championship data available.</div>' :
    `<div style="display:flex;flex-direction:column;gap:.75rem">
      ${championships.map(c => `
        <div style="padding:.6rem;border:1px solid var(--border);border-radius:.5rem;background:var(--bg3)">
          <div style="font-family:var(--font-mono);font-size:.65rem;color:var(--text3);margin-bottom:.3rem">${c.season}–${String(c.season+1).slice(2)}</div>
          <div style="font-size:.9rem;font-weight:700;color:var(--accent)">🏆 ${esc(c.champion)}</div>
          <div style="font-size:.72rem;color:var(--text2);margin-top:.1rem">"${esc(c.champTeam)}" — ${c.champScore.toFixed(2)} pts</div>
          <div style="font-size:.72rem;color:var(--text3);margin-top:.3rem">Runner-up: ${esc(c.runnerUp)} ("${esc(c.runnerUpTeam)}") — ${c.runnerUpScore.toFixed(2)} pts</div>
        </div>`).join('')}
    </div>`}`;

  // Single-game records
  document.getElementById('alltime-game-records').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem">
      <div>
        <div class="card-title" style="font-size:.75rem">Highest Single-Week Scores</div>
        <ol style="padding-left:1.2rem;font-size:.78rem;line-height:1.8">
          ${topWeekScores.map(s => `<li><strong>${s.score.toFixed(2)}</strong> — ${esc(s.owner)} <span style="color:var(--text3)">(Wk ${s.week}, ${s.season}–${String(s.season+1).slice(2)})</span></li>`).join('')}
        </ol>
      </div>
      <div>
        <div class="card-title" style="font-size:.75rem">Lowest Single-Week Scores</div>
        <ol style="padding-left:1.2rem;font-size:.78rem;line-height:1.8">
          ${bottomWeekScores.map(s => `<li><strong>${s.score.toFixed(2)}</strong> — ${esc(s.owner)} <span style="color:var(--text3)">(Wk ${s.week}, ${s.season}–${String(s.season+1).slice(2)})</span></li>`).join('')}
        </ol>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;margin-top:1.5rem">
      <div>
        <div class="card-title" style="font-size:.75rem">Biggest Blowouts</div>
        <ol style="padding-left:1.2rem;font-size:.78rem;line-height:1.8">
          ${blowouts.map(b => `<li><strong>${b.margin.toFixed(2)}</strong> — ${esc(b.winner)} (${b.winScore.toFixed(2)}) def. ${esc(b.loser)} (${b.loseScore.toFixed(2)}) <span style="color:var(--text3)">(${b.weekLabel ?? 'Wk '+b.week}, ${b.season}–${String(b.season+1).slice(2)})</span></li>`).join('')}
        </ol>
      </div>
      <div>
        <div class="card-title" style="font-size:.75rem">Closest Games</div>
        <ol style="padding-left:1.2rem;font-size:.78rem;line-height:1.8">
          ${closestGames.map(g => `<li><strong>${g.margin.toFixed(2)}</strong> — ${esc(g.winner)} (${g.winScore.toFixed(2)}) over ${esc(g.loser)} (${g.loseScore.toFixed(2)}) <span style="color:var(--text3)">(${g.weekLabel ?? 'Wk '+g.week}, ${g.season}–${String(g.season+1).slice(2)})</span></li>`).join('')}
        </ol>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;margin-top:1.5rem">
      <div>
        <div class="card-title" style="font-size:.75rem">Highest Combined Score</div>
        <ol style="padding-left:1.2rem;font-size:.78rem;line-height:1.8">
          ${highestCombined.map(g => `<li><strong>${g.combined.toFixed(2)}</strong> — ${esc(g.winner)} (${g.winScore.toFixed(2)}) vs ${esc(g.loser)} (${g.loseScore.toFixed(2)}) <span style="color:var(--text3)">(${g.weekLabel ?? 'Wk '+g.week}, ${g.season}–${String(g.season+1).slice(2)})</span></li>`).join('')}
        </ol>
      </div>
      <div>
        <div class="card-title" style="font-size:.75rem">Lowest Combined Score</div>
        <ol style="padding-left:1.2rem;font-size:.78rem;line-height:1.8">
          ${lowestCombined.map(g => `<li><strong>${g.combined.toFixed(2)}</strong> — ${esc(g.winner)} (${g.winScore.toFixed(2)}) vs ${esc(g.loser)} (${g.loseScore.toFixed(2)}) <span style="color:var(--text3)">(${g.weekLabel ?? 'Wk '+g.week}, ${g.season}–${String(g.season+1).slice(2)})</span></li>`).join('')}
        </ol>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;margin-top:1.5rem">
      <div>
        <div class="card-title" style="font-size:.75rem">Highest Losing Score</div>
        <ol style="padding-left:1.2rem;font-size:.78rem;line-height:1.8">
          ${highestLosing.map(g => `<li><strong>${g.loserScore.toFixed(2)}</strong> — ${esc(g.loser)} (lost to ${g.winnerScore.toFixed(2)}) <span style="color:var(--text3)">(${g.weekLabel ?? 'Wk '+g.week}, ${g.season}–${String(g.season+1).slice(2)})</span></li>`).join('')}
        </ol>
      </div>
      <div>
        <div class="card-title" style="font-size:.75rem">Lowest Winning Score</div>
        <ol style="padding-left:1.2rem;font-size:.78rem;line-height:1.8">
          ${lowestWinning.map(g => `<li><strong>${g.winnerScore.toFixed(2)}</strong> — ${esc(g.winner)} (beat ${g.loserScore.toFixed(2)}) <span style="color:var(--text3)">(${g.weekLabel ?? 'Wk '+g.week}, ${g.season}–${String(g.season+1).slice(2)})</span></li>`).join('')}
        </ol>
      </div>
    </div>`;

  // Owner H2H
  // Build owner list from 2025+ matchups
  const h2hOwners = [...new Set(h2hMatchups.flatMap(m => [m.homeOwner, m.awayOwner]))].sort();

  // Store H2H data globally for the compare function
  window._allTimeH2H = { ownerH2H, h2hMatchups, h2hOwners };

  const ownerOpts = h2hOwners.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  document.getElementById('alltime-h2h').innerHTML = `
    <div class="compare-bar" style="margin-bottom:1rem">
      <div><label style="font-size:.72rem;color:var(--text3);text-transform:uppercase;letter-spacing:1px">Owner A</label><select id="alltime-h2h-a">${ownerOpts}</select></div>
      <div class="compare-vs">VS</div>
      <div><label style="font-size:.72rem;color:var(--text3);text-transform:uppercase;letter-spacing:1px">Owner B</label><select id="alltime-h2h-b">${ownerOpts}</select></div>
    </div>
    <div id="alltime-h2h-result"></div>
    <div style="margin-top:.75rem;font-size:.68rem;color:var(--text3)">* Only includes matchups from 2025–26 onward (real head-to-head data).</div>`;

  // Default to first two different owners
  if (h2hOwners.length >= 2) document.getElementById('alltime-h2h-b').value = h2hOwners[1];
  const renderAlltimeH2H = () => {
    const a = document.getElementById('alltime-h2h-a').value;
    const b = document.getElementById('alltime-h2h-b').value;
    const target = document.getElementById('alltime-h2h-result');
    if (a === b) { target.innerHTML = `<div style="padding:1rem;color:var(--text2);text-align:center">Pick two different owners.</div>`; return; }
    const key = [a, b].sort().join('|||');
    const rec = window._allTimeH2H.ownerH2H[key];
    const aWins = rec?.[a] ?? 0;
    const bWins = rec?.[b] ?? 0;
    const games = (rec?.games ?? []).sort((x,y) => x.season - y.season || x.week - y.week);
    const totalPFA = games.reduce((s, g) => s + (g.homeOwner === a ? g.homeScore : g.awayScore), 0);
    const totalPFB = games.reduce((s, g) => s + (g.homeOwner === b ? g.homeScore : g.awayScore), 0);
    target.innerHTML = `
      <div style="display:flex;justify-content:center;align-items:center;gap:2rem;margin-bottom:1rem">
        <div style="text-align:center">
          <div style="font-size:1.1rem;font-weight:700;color:${aWins > bWins ? 'var(--accent)' : 'var(--text)'}">${esc(a)}</div>
          <div style="font-size:2rem;font-weight:800;color:${aWins > bWins ? 'var(--accent)' : 'var(--text)'}">${aWins}</div>
          <div style="font-size:.7rem;color:var(--text3)">wins</div>
        </div>
        <div style="font-size:1.5rem;color:var(--text3)">–</div>
        <div style="text-align:center">
          <div style="font-size:1.1rem;font-weight:700;color:${bWins > aWins ? 'var(--accent)' : 'var(--text)'}">${esc(b)}</div>
          <div style="font-size:2rem;font-weight:800;color:${bWins > aWins ? 'var(--accent)' : 'var(--text)'}">${bWins}</div>
          <div style="font-size:.7rem;color:var(--text3)">wins</div>
        </div>
      </div>
      <div style="display:flex;justify-content:center;gap:2rem;font-size:.78rem;color:var(--text2);margin-bottom:1rem">
        <div>Total PF: <strong>${totalPFA.toFixed(2)}</strong> vs <strong>${totalPFB.toFixed(2)}</strong></div>
        <div>Games Played: <strong>${games.length}</strong></div>
      </div>
      ${games.length ? `<table style="width:100%;border-collapse:collapse;font-size:.78rem">
        <thead><tr style="border-bottom:1px solid var(--border);color:var(--text3);font-size:.65rem;text-transform:uppercase;letter-spacing:1px">
          <th style="text-align:left;padding:.3rem">Season</th><th>Week</th><th>${esc(a)}</th><th>${esc(b)}</th><th>Winner</th>
        </tr></thead>
        <tbody>${games.map(g => {
          const aScore = g.homeOwner === a ? g.homeScore : g.awayScore;
          const bScore = g.homeOwner === b ? g.homeScore : g.awayScore;
          const winner = aScore > bScore ? a : b;
          return `<tr style="border-bottom:1px solid var(--border)">
            <td style="padding:.3rem">${g.season}–${String(g.season+1).slice(2)}</td>
            <td class="center">${g.weekLabel ?? ('Wk ' + g.week)}</td>
            <td class="center" style="${aScore > bScore ? 'color:var(--accent);font-weight:700' : ''}">${aScore.toFixed(2)}</td>
            <td class="center" style="${bScore > aScore ? 'color:var(--accent);font-weight:700' : ''}">${bScore.toFixed(2)}</td>
            <td class="center" style="font-weight:600">${esc(winner)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>` : `<div style="text-align:center;color:var(--text3);padding:1rem">No matchups found between these owners.</div>`}
    `;
  };
  document.getElementById('alltime-h2h-a').addEventListener('change', renderAlltimeH2H);
  document.getElementById('alltime-h2h-b').addEventListener('change', renderAlltimeH2H);
  renderAlltimeH2H();

  // Fun Stats
  const avgPFPerSeason = ownerArr.map(([owner, s]) => ({ owner, avg: s.totalPF / Math.max(s.seasons, 1) })).sort((a,b) => b.avg - a.avg);
  const mostChamps = ownerArr.filter(([,s]) => s.championships > 0).sort((a,b) => b[1].championships - a[1].championships);
  const bestWinPct = ownerArr.map(([owner, s]) => ({ owner, pct: s.totalWins / Math.max(s.totalWins + s.totalLosses, 1) })).sort((a,b) => b.pct - a.pct);

  document.getElementById('alltime-fun-stats').innerHTML = `
    <div class="card-title">Superlatives</div>
    <div style="font-size:.8rem;line-height:2">
      <div>🏆 <strong>Most Titles:</strong> ${mostChamps.length ? mostChamps.map(([o,s]) => `${esc(o)} (${s.championships})`).join(', ') : 'N/A'}</div>
      <div>📈 <strong>Best Career Win%:</strong> ${esc(bestWinPct[0]?.owner)} (${(bestWinPct[0]?.pct*100).toFixed(1)}%)</div>
      <div>📉 <strong>Worst Career Win%:</strong> ${esc(bestWinPct[bestWinPct.length-1]?.owner)} (${(bestWinPct[bestWinPct.length-1]?.pct*100).toFixed(1)}%)</div>
      <div>💰 <strong>Most Career PF:</strong> ${esc(ownerArr[0]?.[0])} (${ownerArr[0]?.[1].totalPF.toFixed(0)})</div>
      <div>📊 <strong>Highest Avg PF/Season:</strong> ${esc(avgPFPerSeason[0]?.owner)} (${avgPFPerSeason[0]?.avg.toFixed(0)}/yr)</div>
      <div>🔥 <strong>Highest Single-Week Score:</strong> ${topWeekScores[0]?.score.toFixed(2)} by ${esc(topWeekScores[0]?.owner)} (Wk ${topWeekScores[0]?.week}, ${topWeekScores[0]?.season})</div>
      <div>💀 <strong>Lowest Single-Week Score:</strong> ${bottomWeekScores[0]?.score.toFixed(2)} by ${esc(bottomWeekScores[0]?.owner)} (Wk ${bottomWeekScores[0]?.week}, ${bottomWeekScores[0]?.season})</div>
      <div>💥 <strong>Biggest Blowout:</strong> ${blowouts[0]?.margin.toFixed(2)} pts — ${esc(blowouts[0]?.winner)} over ${esc(blowouts[0]?.loser)} (${blowouts[0]?.weekLabel ?? 'Wk '+blowouts[0]?.week}, ${blowouts[0]?.season})</div>
      <div>🤏 <strong>Closest Game:</strong> ${closestGames[0]?.margin.toFixed(2)} pts — ${esc(closestGames[0]?.winner)} over ${esc(closestGames[0]?.loser)} (${closestGames[0]?.weekLabel ?? 'Wk '+closestGames[0]?.week}, ${closestGames[0]?.season})</div>
    </div>`;

  // Streaks
  document.getElementById('alltime-streaks').innerHTML = `
    <div class="card-title">Streaks & Runs</div>
    <div style="font-size:.8rem;line-height:2">
      <div style="font-weight:600;color:var(--text2);margin-bottom:.3rem">🔥 Longest Win Streaks</div>
      ${winStreaks.slice(0,5).map((s,i) => `<div>${i+1}. <strong>${s.owner}</strong> — ${s.length} wins ${s.start ? `<span style="color:var(--text3)">(${s.start.season} Wk${s.start.week} → ${s.end.season} Wk${s.end.week})</span>` : ''}</div>`).join('')}
      <div style="font-weight:600;color:var(--text2);margin-top:.75rem;margin-bottom:.3rem">💀 Longest Losing Streaks</div>
      ${loseStreaks.slice(0,5).map((s,i) => `<div>${i+1}. <strong>${s.owner}</strong> — ${s.length} losses ${s.start ? `<span style="color:var(--text3)">(${s.start.season} Wk${s.start.week} → ${s.end.season} Wk${s.end.week})</span>` : ''}</div>`).join('')}
    </div>`;

  // Show the view
  document.getElementById('loading').style.display = 'none';
  document.getElementById('app').style.display = 'none';
  document.getElementById('app-alltime').style.display = 'block';
  document.title = "Aldi's FF League · All-Time";
  setStatus('live', 'All-Time Records');
}

// ── Standings ─────────────────────────────────────────────────────────────────
let _standingsListenersWired = false;
function renderStandings() {
  const includePlayoffs = document.getElementById('includePlayoffs')?.checked ?? false;
  const summary = includePlayoffs ? APP.seasonSummaryAll : APP.seasonSummary;
  const weeks   = includePlayoffs ? APP.allCanonical     : APP.completedWeeks;

  // PA per team
  const paByTeam = {};
  APP.teams.forEach(t => paByTeam[t.id] = t.pointsAgainst ?? 0);
  if (includePlayoffs) {
    summary.forEach(s => paByTeam[s.team.id] = s.pointsAgainstFull ?? 0);
  }

  // Playoff-only record (from playoff weekGroups: canonicalWeek > regWeeks)
  const playoffGroups = APP.weekGroups.filter(g => g.canonicalWeek > APP.regWeeks);
  const playoffRec = playoffGroups.length
    ? playoffRecordByGroupRunner(playoffGroups)
    : null;

  // Playoff-only PF / PA per team
  const playoffPF = {}, playoffPA = {};
  APP.teams.forEach(t => { playoffPF[t.id] = 0; playoffPA[t.id] = 0; });
  if (includePlayoffs && playoffGroups.length) {
    playoffGroups.forEach(grp => {
      getGroupMatchups(APP.schedule, grp).forEach(m => {
        if (m.isBye) return;
        if (m.homeTeamId != null) { playoffPF[m.homeTeamId] += m.homeScore; playoffPA[m.homeTeamId] += m.awayScore; }
        if (m.awayTeamId != null) { playoffPF[m.awayTeamId] += m.awayScore; playoffPA[m.awayTeamId] += m.homeScore; }
      });
    });
  }

  const scopeLabel = document.getElementById('standings-scope-label');
  if (scopeLabel) {
    if (includePlayoffs) {
      scopeLabel.textContent = `(${APP.weekGroups.length} games · ${APP.weekGroups[0]?.label}–${APP.weekGroups[APP.weekGroups.length-1]?.label})`;
    } else {
      const range = weeks.length ? `Wk ${weeks[0]}–${weeks[weeks.length-1]}` : '—';
      scopeLabel.textContent = `(${weeks.length} weeks · ${range})`;
    }
  }

  // Build header dynamically — always left-aligned values + optional Playoff column
  const thead = document.getElementById('standings-thead');
  const playoffCol = (includePlayoffs && playoffRec)
    ? `<th data-sort="po" data-numeric="true" title="Wins-Losses during playoff weeks only">PO REC</th>` : '';
  const playoffPFPACol = (includePlayoffs && playoffGroups.length)
    ? `<th data-sort="popf" data-numeric="true" title="Playoff Points For">PO PF</th><th data-sort="popa" data-numeric="true" title="Playoff Points Against">PO PA</th>` : '';
  const paCol = APP.isHistorical ? '' : `<th data-sort="pa" data-numeric="true" title="Points Against">PA</th>`;
  thead.innerHTML = `
    <th data-sort="rank" data-numeric="true">Rank</th>
    <th data-sort="name">Team</th>
    <th data-sort="wins" data-numeric="true">W</th>
    <th data-sort="losses" data-numeric="true">L</th>
    <th data-sort="pct" data-numeric="true">W%</th>
    ${playoffCol}
    <th data-sort="pf" data-numeric="true" title="Points For">PF</th>
    ${paCol}
    ${playoffPFPACol}
    <th data-sort="avg" data-numeric="true" title="Average Points Per Week">AVG/WK</th>
    <th data-sort="xw" data-numeric="true" title="Scaled Expected Wins">xW</th>
    <th data-sort="xl" data-numeric="true" title="Scaled Expected Losses">xL</th>
    <th data-sort="wax" data-numeric="true" title="Wins Above Expected">W−xW</th>`;

  const sorted = [...summary].sort((a, b) => b.wins - a.wins || b.totalPts - a.totalPts);
  const tbody = document.getElementById('standings-body');
  const totalGames = includePlayoffs ? APP.weekGroups.length : weeks.length;
  tbody.innerHTML = sorted.map((s, i) => {
    const pct = totalGames ? (s.wins / totalGames) : 0;
    const wax = s.wins - s.xW;
    const pa = paByTeam[s.team.id] ?? 0;
    const po = playoffRec ? playoffRec[s.team.id] : null;
    const poCell = (includePlayoffs && playoffRec)
      ? `<td class="mono std-cell" data-val="${po?.wins ?? 0}">${po ? `${po.wins}-${po.losses}` : '—'}</td>` : '';
    const poPFPACell = (includePlayoffs && playoffGroups.length)
      ? `<td class="mono std-cell" data-val="${playoffPF[s.team.id]}">${playoffPF[s.team.id].toFixed(2)}</td><td class="mono std-cell dim" data-val="${playoffPA[s.team.id]}">${playoffPA[s.team.id].toFixed(2)}</td>` : '';
    return `<tr>
      <td data-val="${i+1}"><span class="rank rank-${i+1}">${i+1}</span></td>
      <td>
        <div class="team-name">${esc(s.team.name)}</div>
        <div class="owner-name">${esc(ownerStr(s.team))}</div>
      </td>
      <td class="mono std-cell" data-val="${s.wins}">${s.wins}</td>
      <td class="mono std-cell" data-val="${s.losses}">${s.losses}</td>
      <td class="mono std-cell" data-val="${pct}">${(pct*100).toFixed(1)}%</td>
      ${poCell}
      <td class="mono std-cell" data-val="${s.totalPts}">${s.totalPts.toFixed(2)}</td>
      ${APP.isHistorical ? '' : `<td class="mono std-cell dim" data-val="${pa}">${pa.toFixed(2)}</td>`}
      ${poPFPACell}
      <td class="mono std-cell" data-val="${s.avgPts}">${s.avgPts.toFixed(2)}</td>
      <td class="mono std-cell highlight" data-val="${s.xW}">${s.xW.toFixed(3)}</td>
      <td class="mono std-cell dim" data-val="${s.xL}">${s.xL.toFixed(3)}</td>
      <td class="mono std-cell ${wax > 0 ? 'positive' : wax < 0 ? 'negative' : 'neutral'}" data-val="${wax}">${wax > 0 ? '+' : ''}${wax.toFixed(3)}</td>
    </tr>`;
  }).join('');

  // Re-wire sort listeners every render (header is rebuilt each time)
  document.querySelectorAll('#standings-table thead th[data-sort]').forEach(th => {
    th.addEventListener('click', () => sortTable('standings-table', th));
  });

  if (!_standingsListenersWired) {
    document.getElementById('includePlayoffs')?.addEventListener('change', renderStandings);
    _standingsListenersWired = true;
  }
}

// Helper that uses the imported playoffRecordByGroup (for use inside renderStandings closure)
function playoffRecordByGroupRunner(playoffGroups) {
  return playoffRecordByGroup(APP.schedule, APP.teams, playoffGroups);
}

// ── Playoff matchup labeling ─────────────────────────────────────────────────
function labelPlayoffMatchups(matchups, grp, regWeeks, seed, schedule, weekGroups) {
  const out = matchups.filter(m => !m.isBye).map(() => null);
  if (!seed || seed.length < 8) return out;
  if (grp.canonicalWeek <= regWeeks) return out;
  const seedIds = seed.map(t => t.id);
  const top4 = new Set(seedIds.slice(0, 4));
  const bot4 = new Set(seedIds.slice(4, 8));
  const isTop4Pair = (m) => top4.has(m.homeTeamId) && top4.has(m.awayTeamId);
  const isBot4Pair = (m) => bot4.has(m.homeTeamId) && bot4.has(m.awayTeamId);

  // Find playoff groups (all groups whose canonicalWeek > regWeeks)
  const playoffGroups = weekGroups.filter(g => g.canonicalWeek > regWeeks);
  const round1Group = playoffGroups[0];
  const round2Group = playoffGroups[1];

  // Round 1 — first playoff group
  if (round1Group && grp.canonicalWeek === round1Group.canonicalWeek) {
    matchups.filter(m => !m.isBye).forEach((m, i) => {
      if (isTop4Pair(m))      out[i] = { text: '🏆 Playoff Semifinal', cls: 'tag-playoff' };
      else if (isBot4Pair(m)) out[i] = { text: '🍂 Consolation Round 1', cls: 'tag-consolation' };
      else                    out[i] = { text: 'Playoff Round 1', cls: 'tag-playoff' };
    });
    return out;
  }

  // Round 2 — finals + 3rd / 5th / 7th
  if (!round1Group) return out;
  const r1Matchups = getGroupMatchups(schedule, round1Group);
  const winnerOf = {}, loserOf = {};
  r1Matchups.filter(m => !m.isBye).forEach(m => {
    if (m.homeScore > m.awayScore) {
      winnerOf[m.homeTeamId] = true; loserOf[m.awayTeamId] = true;
    } else if (m.awayScore > m.homeScore) {
      winnerOf[m.awayTeamId] = true; loserOf[m.homeTeamId] = true;
    }
  });
  matchups.filter(m => !m.isBye).forEach((m, i) => {
    const tInTop = top4.has(m.homeTeamId) && top4.has(m.awayTeamId);
    const tInBot = bot4.has(m.homeTeamId) && bot4.has(m.awayTeamId);
    const bothWon  = winnerOf[m.homeTeamId] && winnerOf[m.awayTeamId];
    const bothLost = loserOf[m.homeTeamId]  && loserOf[m.awayTeamId];
    if (tInTop && bothWon)       out[i] = { text: '🏆 CHAMPIONSHIP',       cls: 'tag-championship' };
    else if (tInTop && bothLost) out[i] = { text: '🥉 3rd-Place Game',     cls: 'tag-playoff' };
    else if (tInBot && bothWon)  out[i] = { text: '🥄 5th-Place Game',     cls: 'tag-consolation' };
    else if (tInBot && bothLost) out[i] = { text: '🚽 7th-Place (Toilet Bowl)', cls: 'tag-toilet' };
    else                         out[i] = { text: 'Playoff Round 2',       cls: 'tag-playoff' };
  });
  return out;
}

// ── Weekly Scores (TRANSPOSED) ────────────────────────────────────────────────
let _scoresListenersWired = false;
function renderWeeklyScores() {
  const { teams, weeklyScores, biweeklyScores, weekGroups, extremes } = APP;
  const show2Wk = document.getElementById('show2WkRolling')?.checked ?? false;

  // Header: blank + each TEAM with TEAM NAME on top and OWNER NAME below in smaller font
  const thead = document.getElementById('scores-thead');
  thead.innerHTML = `<th style="text-align:center"></th>` +
    teams.map(t => `<th class="center" title="${esc(ownerStr(t))}" style="max-width:7rem;word-wrap:break-word;overflow-wrap:break-word">
      <div style="font-weight:600;font-size:.78rem;color:var(--text);text-transform:none;letter-spacing:.5px;white-space:normal;word-break:break-word">${esc(t.name)}</div>
      <div style="font-weight:400;font-size:.62rem;color:var(--text3);text-transform:none;letter-spacing:.3px;margin-top:.15rem;white-space:normal;word-break:break-word">${esc(ownerStr(t))}</div>
    </th>`).join('');

  const tbody = document.getElementById('scores-body');

  if (!show2Wk) {
    // ── Single-week view — show every individual week (no combining) ────────
    const allWeeks = Object.keys(weeklyScores[teams[0]?.id] || {})
      .map(Number)
      .filter(w => teams.some(t => (weeklyScores[t.id]?.[w] ?? 0) > 0))
      .sort((a, b) => a - b);
    tbody.innerHTML = allWeeks.map(w => {
      const teamScore = (t) => weeklyScores[t.id]?.[w] ?? 0;
      const groupScores = teams.map(t => teamScore(t)).filter(v => v > 0);
      const groupMax = groupScores.length ? Math.max(...groupScores) : 0;
      const groupMin = groupScores.length ? Math.min(...groupScores) : 0;
      const cells = teams.map(t => {
        const score = teamScore(t);
        const isHigh = score === groupMax && score > 0;
        const isLow  = score === groupMin && score > 0;
        const cls = isHigh ? 'score-cell high' : isLow ? 'score-cell low' : 'score-cell';
        return `<td class="${cls}">${score > 0 ? score.toFixed(2) : '—'}</td>`;
      }).join('');
      return `<tr><td style="text-align:center"><strong>Wk ${w}</strong></td>${cells}</tr>`;
    }).join('');
  } else {
    // ── 2-week rolling view ────────────────────────────────────────────────
    // Iterate every CONSECUTIVE pair of individual weeks that have data.
    // We don't use canonical weeks here — that would skip a step (e.g. wk 17
    // is canonical for the [16,17] group, so canonical-only would jump 15→17).
    const allWeeks = Object.keys(weeklyScores[teams[0].id] || {})
      .map(Number)
      .filter(w => teams.some(t => (weeklyScores[t.id]?.[w] ?? 0) > 0))
      .sort((a, b) => a - b);
    const rows = [];
    for (let i = 1; i < allWeeks.length; i++) {
      const prev = allWeeks[i - 1];
      const curr = allWeeks[i];
      const teamScore = (t) =>
        (weeklyScores[t.id]?.[prev] ?? 0) + (weeklyScores[t.id]?.[curr] ?? 0);
      const groupScores = teams.map(t => teamScore(t)).filter(v => v > 0);
      const groupMax = groupScores.length ? Math.max(...groupScores) : 0;
      const groupMin = groupScores.length ? Math.min(...groupScores) : 0;
      const cells = teams.map(t => {
        const score = teamScore(t);
        const isHigh = score === groupMax && score > 0;
        const isLow  = score === groupMin && score > 0;
        const cls = isHigh ? 'score-cell high' : isLow ? 'score-cell low' : 'score-cell';
        return `<td class="${cls}">${score > 0 ? score.toFixed(2) : '—'}</td>`;
      }).join('');
      rows.push(`<tr><td style="text-align:center"><strong>Wk ${prev}-${curr}</strong></td>${cells}</tr>`);
    }
    tbody.innerHTML = rows.join('');
  }

  // Always-visible footer rows: hi/lo wks, hi/lo 2-wks, total TDs.
  // Each row has its own max highlighted cyan and min highlighted red.
  const tfoot = document.getElementById('scores-tfoot');
  const totalTDs = APP.totalTDs ?? {};
  const lblStyle = `font-family:var(--font-mono);font-size:.65rem;color:var(--text3);letter-spacing:1px;text-align:center`;

  // For each row, build cells with conditional highlight based on row's max/min.
  // `kind` controls which extreme gets which color:
  //   'highIsBest' → max gets cyan, min gets red (e.g. HI WKS, TOTAL TDS)
  //   'lowIsBest'  → max gets red, min gets cyan (e.g. LO WKS — fewer is better)
  const rowCells = (counts, kind) => {
    const vals = teams.map(t => Number(counts[t.id] ?? 0));
    const max = Math.max(...vals);
    const min = Math.min(...vals);
    const allEqual = max === min;
    return teams.map(t => {
      const v = Number(counts[t.id] ?? 0);
      let cls = 'score-cell';
      if (!allEqual) {
        const isMax = v === max;
        const isMin = v === min;
        if (kind === 'lowIsBest') {
          if (isMin) cls = 'score-cell high';
          else if (isMax) cls = 'score-cell low';
        } else {
          if (isMax) cls = 'score-cell high';
          else if (isMin) cls = 'score-cell low';
        }
      }
      return `<td class="${cls}" style="text-align:center">${v}</td>`;
    }).join('');
  };

  tfoot.innerHTML = `
    <tr style="border-top:2px solid var(--border)">
      <td style="${lblStyle}">HI WKS</td>
      ${rowCells(extremes.highWeek, 'highIsBest')}
    </tr>
    <tr>
      <td style="${lblStyle}">LO WKS</td>
      ${rowCells(extremes.lowWeek, 'lowIsBest')}
    </tr>
    <tr>
      <td style="${lblStyle}">HI 2-WK</td>
      ${rowCells(extremes.highBiweek, 'highIsBest')}
    </tr>
    <tr>
      <td style="${lblStyle}">LO 2-WK</td>
      ${rowCells(extremes.lowBiweek, 'lowIsBest')}
    </tr>
    ${APP.isHistorical ? '' : `<tr>
      <td style="${lblStyle}">TOTAL TDS</td>
      ${rowCells(totalTDs, 'highIsBest')}
    </tr>`}`;

  if (!_scoresListenersWired) {
    document.getElementById('show2WkRolling')?.addEventListener('change', renderWeeklyScores);
    _scoresListenersWired = true;
  }
}

// ── Matchups ──────────────────────────────────────────────────────────────────
let currentMatchupGroupIdx = 0;
function renderMatchupSelector() {
  const { weekGroups } = APP;
  const selector = document.getElementById('matchup-week-selector');
  currentMatchupGroupIdx = Math.max(0, weekGroups.length - 1);

  selector.innerHTML = weekGroups.map((g, i) =>
    `<button class="week-btn ${i === currentMatchupGroupIdx ? 'active' : ''}" data-gidx="${i}">${esc(g.label)}</button>`
  ).join('');
  selector.querySelectorAll('.week-btn').forEach(btn => {
    btn.addEventListener('click', () => selectMatchupGroup(parseInt(btn.dataset.gidx)));
  });
  renderMatchups(currentMatchupGroupIdx);
}

function selectMatchupGroup(idx) {
  currentMatchupGroupIdx = idx;
  document.querySelectorAll('#matchup-week-selector .week-btn').forEach((btn) => {
    btn.classList.toggle('active', parseInt(btn.dataset.gidx) === idx);
  });
  renderMatchups(idx);
}

function renderMatchups(groupIdx) {
  const { schedule, teamById, weekGroups, regWeeks, regSeed } = APP;
  const grp = weekGroups[groupIdx];
  if (!grp) return;
  const matchups = getGroupMatchups(schedule, grp);
  const grid = document.getElementById('matchup-grid');

  if (!matchups.length) { grid.innerHTML = '<p style="color:var(--text2)">No matchups for this week.</p>'; return; }

  // Determine playoff label for each matchup (only meaningful for Wk >= 15)
  const playoffLabels = labelPlayoffMatchups(matchups, grp, regWeeks, regSeed, schedule, weekGroups);

  const playable = matchups.filter(m => !m.isBye);
  grid.innerHTML = playable.map((m, idx) => {
    const homeTeam = teamById[m.homeTeamId] ?? null;
    const awayTeam = teamById[m.awayTeamId] ?? null;
    const homeWin = m.homeScore > m.awayScore;
    const awayWin = m.awayScore > m.homeScore;
    const hasLineup = (m.homeLineup && m.homeLineup.length) || (m.awayLineup && m.awayLineup.length);
    const combinedHint = grp.combined
      ? `<div style="text-align:center;font-size:.65rem;color:var(--gold);margin-top:.1rem">cumulative ${esc(grp.label)} score</div>` : '';
    const clickHint = hasLineup
      ? `<div style="text-align:center;font-size:.65rem;color:var(--text3)">click to view lineups${grp.combined ? ' (toggle by week)' : ''}</div>`
      : '';
    const winnerLine = (m.homeScore > 0 || m.awayScore > 0)
      ? `<div style="text-align:center;font-size:.75rem;color:var(--text3)">${
            homeWin ? '✓ ' + esc(homeTeam?.name ?? 'Unknown') + ' wins'
          : awayWin ? '✓ ' + esc(awayTeam?.name ?? 'Unknown') + ' wins'
          : 'Tie'}</div>`
      : `<div style="text-align:center;font-size:.75rem;color:var(--text3)">Upcoming</div>`;
    const tag = playoffLabels[idx];
    const tagBar = tag
      ? `<div class="matchup-tag ${tag.cls}">${esc(tag.text)}</div>` : '';
    return `<div class="matchup-card ${hasLineup ? '' : 'no-detail'}" data-gidx="${groupIdx}" data-idx="${idx}">
      ${tagBar}
      <div class="matchup-h">
        <div class="matchup-side">
          <div class="name">${esc(homeTeam?.name ?? 'Unknown')}</div>
          <div class="owner">${esc(ownerStr(homeTeam ?? {}))}</div>
          <div class="score ${homeWin ? 'winner' : ''}">${m.homeScore.toFixed(2)}</div>
        </div>
        <div class="matchup-vs-mid">VS</div>
        <div class="matchup-side right">
          <div class="name">${esc(awayTeam?.name ?? 'Unknown')}</div>
          <div class="owner">${esc(ownerStr(awayTeam ?? {}))}</div>
          <div class="score ${awayWin ? 'winner' : ''}">${m.awayScore.toFixed(2)}</div>
        </div>
      </div>
      ${winnerLine}
      ${combinedHint}
      ${clickHint}
    </div>`;
  }).join('');

  grid.querySelectorAll('.matchup-card').forEach(card => {
    card.addEventListener('click', () => {
      const g = parseInt(card.dataset.gidx);
      const i = parseInt(card.dataset.idx);
      openMatchupModal(g, i);
    });
  });
}

// ── Matchup detail modal ───────────────────────────────────────────────────────
const STARTER_SLOTS = new Set(['QB','RB','WR','TE','FLEX','RB/WR/TE','OP','D/ST','DST','DEF','K']);
const BENCH_SLOTS   = new Set(['BE','Bench','BENCH']);
const IR_SLOTS      = new Set(['IR','IR/RES']);

function classifySlot(slot) {
  if (!slot) return 'unknown';
  const s = String(slot).toUpperCase();
  if (BENCH_SLOTS.has(slot) || s === 'BE' || s === 'BENCH') return 'bench';
  if (IR_SLOTS.has(slot) || s.startsWith('IR')) return 'ir';
  return 'starter';
}

/** RB/WR/TE → FLEX, RB/WR → FLEX, etc. Otherwise return the slot as-is. */
function formatSlot(slot) {
  if (!slot) return '?';
  const s = String(slot);
  if (s.includes('/') && /(RB|WR|TE)/i.test(s)) return 'FLEX';
  return s;
}

function renderLineupColumn(team, score, lineup, isWinner) {
  const grouped = { starter: [], bench: [], ir: [] };
  (lineup || []).forEach(p => {
    const cat = classifySlot(p.slot);
    grouped[cat].push(p);
  });

  // Order starters by typical slot order
  const slotOrder = ['QB','RB','WR','TE','FLEX','RB/WR/TE','OP','D/ST','DST','DEF','K'];
  grouped.starter.sort((a, b) => {
    const ai = slotOrder.indexOf(String(a.slot).toUpperCase());
    const bi = slotOrder.indexOf(String(b.slot).toUpperCase());
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  const playerRow = (p, kind) => {
    const slotClass = kind === 'bench' ? '' : (kind === 'ir' ? 'ir' : 'starter');
    const slotDisplay = formatSlot(p.slot);
    const flexish = slotDisplay === 'FLEX' ? 'flex' : '';
    const ptsCls = (p.points || 0) === 0 ? 'zero' : '';
    // Register the player in the modal-player registry; row carries an index
    const i = window._modalPlayers.length;
    window._modalPlayers.push(p);
    return `<div class="player-row ${kind}" data-pidx="${i}">
      <div class="player-slot ${slotClass} ${flexish}">${esc(slotDisplay)}</div>
      <div>
        <div class="player-name">${esc(p.name ?? '—')}</div>
        <div class="player-meta">${esc((p.position ?? '') + (p.proTeam ? ' · ' + p.proTeam : ''))}</div>
      </div>
      <div class="player-pts ${ptsCls}">${(p.points || 0).toFixed(2)}</div>
    </div>`;
  };

  const sectionHTML = (title, players, kind) => {
    if (!players.length) return '';
    return `<div class="lineup-section-title">${title}</div>` +
      players.map(p => playerRow(p, kind)).join('');
  };

  return `<div class="lineup-col">
    <h3>${esc(team?.name ?? 'Unknown')}</h3>
    <div class="owner-line">${esc(ownerStr(team ?? {}))}</div>
    <div class="total-line ${isWinner ? 'winner' : ''}">${score.toFixed(2)}</div>
    ${sectionHTML('Starters', grouped.starter, 'starter')}
    ${sectionHTML('Bench',    grouped.bench,   'bench')}
    ${sectionHTML('Injured Reserve', grouped.ir, 'ir')}
    ${(!grouped.starter.length && !grouped.bench.length && !grouped.ir.length)
      ? `<div class="player-row empty"><div></div><div>No lineup data available</div><div></div></div>`
      : ''}
  </div>`;
}

// ── Score breakdown tooltip ───────────────────────────────────────────────────
window._modalPlayers = [];

// ESPN numeric stat IDs → friendly names. Older versions of espn_api expose
// the breakdown keyed by these numeric IDs; newer versions use friendly names.
// This map covers both, plus a few defense/kicker scoring stats.
const ESPN_STAT_ID = {
  '0': 'passingAttempts', '1': 'passingCompletions', '2': 'passingIncompletions',
  '3': 'passingYards', '4': 'passingTouchdowns', '19': 'passing2PtConversions',
  '20': 'passingInterceptions',
  '23': 'rushingAttempts', '24': 'rushingYards', '25': 'rushingTouchdowns',
  '26': 'rushing2PtConversions',
  '40': 'receivingReceptions', '41': 'receivingYards', '42': 'receivingTouchdowns',
  '43': 'receivingTargets', '44': 'receiving2PtConversions',
  '53': 'receivingReceptions',
  '63': 'fumbles', '68': 'fumblesLost', '72': 'lostFumbles',
  '74': 'madeFieldGoalsFrom17To19', '77': 'madeFieldGoalsFrom20To29',
  '80': 'madeFieldGoalsFrom30To39', '83': 'madeFieldGoalsFrom40To49',
  '86': 'madeFieldGoalsFromOver50', '88': 'extraPoints', '89': 'extraPointAttempts',
  '93': 'extraPoints', '95': 'missedFieldGoals',
  '96': 'totalPointsAllowed', '97': 'pointsAllowed1To6', '98': 'pointsAllowed7To13',
  '99': 'pointsAllowed14To17', '100': 'pointsAllowed18To21', '101': 'pointsAllowed22To27',
  '102': 'pointsAllowed28To34', '103': 'pointsAllowed35To45', '104': 'pointsAllowed46Plus',
  '106': 'sacks', '107': 'fumblesRecoveredByDefense', '108': 'interceptions',
  '109': 'safeties', '110': 'touchdownsByDefense', '113': 'blockedFGTouchdowns',
  '114': 'blockedPuntTouchdowns', '115': 'blockedPunts', '116': 'blockedPats',
  '120': 'pointsAllowed', '123': 'puntReturnTouchdowns', '124': 'kickReturnTouchdowns',
};

function statLabel(key) {
  let name = String(key);
  // If the key is a numeric ESPN stat ID, translate it first
  if (/^\d+$/.test(name) && ESPN_STAT_ID[name]) name = ESPN_STAT_ID[name];
  // If the label already has spaces (it's the league's own label), pass through
  if (/\s/.test(name)) return name;
  // Otherwise camelCase → Camel Case
  const pretty = name
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, c => c.toUpperCase())
    .trim()
    .replace(/\bTd\b/g, 'TD')
    .replace(/\bTds\b/g, 'TDs')
    .replace(/\bInt\b/g, 'INT')
    .replace(/\bYds?\b/gi, 'Yds')
    .replace(/\b2 Pt\b/gi, '2-Pt')
    .replace(/\bPat\b/gi, 'PAT')
    .replace(/\bFg\b/g, 'FG');
  return /^\d+$/.test(pretty) ? `Stat #${pretty}` : pretty;
}

function rawValueLabelForKey(key, raw) {
  // Resolve numeric → friendly first so rawValueLabel's keyword sniffing works
  let name = String(key);
  if (/^\d+$/.test(name) && ESPN_STAT_ID[name]) name = ESPN_STAT_ID[name];
  return rawValueLabel(name, raw);
}

function rawValueLabel(key, raw) {
  const k = String(key).toLowerCase();
  if (k.includes('yard'))      return `${raw.toFixed(0)} yds`;
  if (k.includes('touchdown')) return `${raw.toFixed(0)} TD`;
  if (k.includes('reception')) return `${raw.toFixed(0)} rec`;
  if (k.includes('completion'))return `${raw.toFixed(0)} comp`;
  if (k.includes('attempt'))   return `${raw.toFixed(0)} att`;
  if (k.includes('interception')) return `${raw.toFixed(0)}`;
  if (k.includes('fumble'))    return `${raw.toFixed(0)}`;
  if (k.includes('sack'))      return `${raw.toFixed(0)}`;
  if (k.includes('extra'))     return `${raw.toFixed(0)} XP`;
  if (k.includes('field'))     return `${raw.toFixed(0)} FG`;
  return raw % 1 === 0 ? raw.toString() : raw.toFixed(2);
}

function showBreakdownTip(e, p) {
  const tip = document.getElementById('breakdown-tip');
  const breakdown = p.breakdown || {};
  const rawStats  = p.rawStats  || {};

  const entries = Object.entries(breakdown)
    .filter(([, v]) => Math.abs(v) > 0.001)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));

  let body;
  if (!entries.length) {
    // Two reasons we'd be empty:
    //  1) The player did literally nothing (DNP / 0 stats)
    //  2) data.json was generated before per-stat breakdowns were added
    const hasField = p.breakdown !== undefined;
    body = hasField
      ? `<div class="tip-empty">No fantasy-scoring stats this week.</div>`
      : `<div class="tip-empty">Per-stat breakdown not in <code>data.json</code> yet — re-run <code>python fetch.py</code> to populate it.</div>`;
  } else {
    body = entries.map(([k, pts]) => {
      const raw = rawStats[k];
      const rawHTML = (raw !== undefined && raw !== null)
        ? `<span class="raw">${esc(rawValueLabelForKey(k, raw))}</span>` : '';
      const ptsCls = pts < 0 ? 'neg' : '';
      const sign   = pts > 0 ? '+' : '';
      return `<div class="breakdown-row">
        <span class="stat-name">${esc(statLabel(k))}${rawHTML}</span>
        <span class="stat-pts ${ptsCls}">${sign}${pts.toFixed(2)}</span>
      </div>`;
    }).join('');
  }

  tip.innerHTML =
    `<h4>${esc(p.name ?? '—')}</h4>
     <div class="tip-meta">
       ${esc((p.position ?? '') + (p.proTeam ? ' · ' + p.proTeam : ''))}
       · Total: <strong style="color:var(--text)">${(p.points || 0).toFixed(2)}</strong>
       (proj ${(p.projected || 0).toFixed(2)})
     </div>
     ${body}`;

  tip.classList.add('visible');
  positionBreakdownTip(e);
}

function positionBreakdownTip(e) {
  const tip = document.getElementById('breakdown-tip');
  const pad = 14;
  const { innerWidth: vw, innerHeight: vh } = window;
  const r = tip.getBoundingClientRect();
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  if (x + r.width > vw - 8)  x = e.clientX - r.width - pad;
  if (y + r.height > vh - 8) y = e.clientY - r.height - pad;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top  = `${Math.max(8, y)}px`;
}

function hideBreakdownTip() {
  document.getElementById('breakdown-tip').classList.remove('visible');
}

function wireBreakdownHovers(scope) {
  scope.querySelectorAll('.player-row[data-pidx]').forEach(row => {
    const idx = parseInt(row.dataset.pidx);
    const p = window._modalPlayers[idx];
    if (!p) return;
    row.addEventListener('mouseenter', (e) => showBreakdownTip(e, p));
    row.addEventListener('mousemove',  positionBreakdownTip);
    row.addEventListener('mouseleave', hideBreakdownTip);
  });
}

// State for the modal: which group, which matchup index, which week within the group
let _modalState = { gIdx: 0, mIdx: 0, weekChoice: null };

window.openMatchupModal = function(groupIdx, matchupIdx) {
  const grp = APP.weekGroups[groupIdx];
  if (!grp) return;
  _modalState = { gIdx: groupIdx, mIdx: matchupIdx, weekChoice: grp.weeks[0] };
  renderMatchupModalContents();
  document.getElementById('matchup-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
};

function renderMatchupModalContents() {
  const { schedule, teamById, weekGroups } = APP;
  const { gIdx, mIdx, weekChoice } = _modalState;
  const grp = weekGroups[gIdx];
  if (!grp) return;

  // Header score = the SUMMED cumulative for combined groups (or single-week for standalone)
  const cardMatchup = getGroupMatchups(schedule, grp).filter(m => !m.isBye)[mIdx];
  if (!cardMatchup) return;
  const homeTeam = teamById[cardMatchup.homeTeamId] ?? null;
  const awayTeam = teamById[cardMatchup.awayTeamId] ?? null;
  const homeWin = cardMatchup.homeScore > cardMatchup.awayScore;
  const awayWin = cardMatchup.awayScore > cardMatchup.homeScore;

  // Lineup data for the chosen week (could differ per week in a combined group)
  const lineupMatchup = (schedule[weekChoice] ?? []).filter(m => !m.isBye)[mIdx] || cardMatchup;
  const homeLineup = lineupMatchup.homeLineup || [];
  const awayLineup = lineupMatchup.awayLineup || [];
  // Use the score from the same scope as the lineup — single-week score for that week
  const homeScore = lineupMatchup.homeScore ?? 0;
  const awayScore = lineupMatchup.awayScore ?? 0;

  // Title
  const titleSuffix = grp.combined ? ` · ${grp.label}` : '';
  document.getElementById('matchup-modal-title').textContent =
    `${grp.combined ? grp.label : ('Week ' + grp.canonicalWeek)} · ${homeTeam?.name ?? 'Unknown'} vs ${awayTeam?.name ?? 'Unknown'}`;

  // Build the body: optional week-toggle bar (only when group is combined) + two lineup columns
  const body = document.getElementById('matchup-modal-body');
  let toggleBar = '';
  if (grp.combined && grp.weeks.length > 1) {
    toggleBar = `<div style="grid-column: 1 / -1; display:flex; gap:.5rem; align-items:center; margin-bottom:.25rem">
      <span style="font-family:var(--font-mono);font-size:.7rem;color:var(--text3);letter-spacing:1.5px;text-transform:uppercase;margin-right:.5rem">Lineup for</span>
      ${grp.weeks.map(w => `<button class="week-btn ${w === weekChoice ? 'active' : ''}" data-w="${w}">Wk ${w}</button>`).join('')}
      <span style="margin-left:auto;font-size:.72rem;color:var(--text2)">
        Cumulative score: <strong style="color:${homeWin ? 'var(--win)' : 'var(--text)'}">${cardMatchup.homeScore.toFixed(2)}</strong>
        – <strong style="color:${awayWin ? 'var(--win)' : 'var(--text)'}">${cardMatchup.awayScore.toFixed(2)}</strong>
      </span>
    </div>`;
  }

  window._modalPlayers = [];
  const cols =
    renderLineupColumn(homeTeam, homeScore, homeLineup, homeScore > awayScore) +
    renderLineupColumn(awayTeam, awayScore, awayLineup, awayScore > homeScore);

  body.innerHTML = toggleBar + cols;

  // Wire hover tooltips and the week-toggle
  wireBreakdownHovers(body);
  body.querySelectorAll('.week-btn[data-w]').forEach(btn => {
    btn.addEventListener('click', () => {
      _modalState.weekChoice = parseInt(btn.dataset.w);
      renderMatchupModalContents();
    });
  });

  const note = document.getElementById('matchup-modal-note');
  const hasLineup = homeLineup.length || awayLineup.length;
  if (!hasLineup) {
    note.style.display = '';
    note.innerHTML = `⚠ No player-level data found in <code>data.json</code>. Re-run <code>python fetch.py</code> to pull this week's lineups from ESPN.`;
  } else {
    note.style.display = 'none';
  }
}

window.closeMatchupModal = function() {
  document.getElementById('matchup-modal').classList.remove('open');
  document.body.style.overflow = '';
  hideBreakdownTip();
};

// Close on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMatchupModal();
});

// ── H2H — Compare two teams ───────────────────────────────────────────────────
function renderCompareDropdowns() {
  const { teams } = APP;
  const sa = document.getElementById('cmpA');
  const sb = document.getElementById('cmpB');
  const opts = teams.map(t => `<option value="${t.id}">${esc(t.name)} — ${esc(ownerStr(t))}</option>`).join('');
  sa.innerHTML = opts;
  sb.innerHTML = opts;
  sa.value = teams[0]?.id;
  sb.value = teams[1]?.id;
  sa.addEventListener('change', renderCompareResult);
  sb.addEventListener('change', renderCompareResult);
  renderCompareResult();
}

function renderCompareResult() {
  const { teams, weeklyScores, completedWeeks, schedule, seasonSummary, h2hRecords } = APP;
  const aId = parseInt(document.getElementById('cmpA').value);
  const bId = parseInt(document.getElementById('cmpB').value);
  const tA = teams.find(t => t.id === aId);
  const tB = teams.find(t => t.id === bId);
  const target = document.getElementById('compare-result');

  if (!tA || !tB) { target.innerHTML = ''; return; }
  if (tA.id === tB.id) {
    target.innerHTML = `<div style="padding:1rem;color:var(--text2);text-align:center">Pick two different teams to compare.</div>`;
    return;
  }

  const sA = seasonSummary.find(s => s.team.id === tA.id);
  const sB = seasonSummary.find(s => s.team.id === tB.id);
  const key = [tA.id, tB.id].sort().join('_');
  const allPlay = h2hRecords[key] || {};
  const aAllPlayW = allPlay[tA.id] ?? 0, bAllPlayW = allPlay[tB.id] ?? 0;

  // Find actual head-to-head matchups in the schedule
  let aActualW = 0, bActualW = 0, ties = 0;
  const realMatchups = [];
  completedWeeks.forEach(w => {
    (schedule[w] ?? []).forEach(m => {
      if (m.isBye) return;
      const h = m.homeTeamId, a = m.awayTeamId;
      if ((h === aId && a === bId) || (h === bId && a === aId)) {
        const aScore = h === aId ? m.homeScore : m.awayScore;
        const bScore = h === bId ? m.homeScore : m.awayScore;
        if (aScore > bScore) aActualW++;
        else if (bScore > aScore) bActualW++;
        else ties++;
        realMatchups.push({ week: w, aScore, bScore });
      }
    });
  });

  const cmp = (av, bv, fmt) => {
    const aWin = av > bv, bWin = bv > av;
    return `<div class="compare-stat-row">
      <span class="lbl">${fmt.lbl}</span>
      <span style="display:flex;gap:1rem">
        <span class="val ${aWin ? 'win' : ''}">${fmt.fa(av)}</span>
        <span style="color:var(--text3)">vs</span>
        <span class="val ${bWin ? 'win' : ''}">${fmt.fb(bv)}</span>
      </span>
    </div>`;
  };

  // Combined record (W-L) string vs. comparable raw value for highlighting
  const recordRow = (() => {
    const aRec = `${sA.wins}-${sA.losses}`;
    const bRec = `${sB.wins}-${sB.losses}`;
    const aWin = sA.wins > sB.wins, bWin = sB.wins > sA.wins;
    return `<div class="compare-stat-row">
      <span class="lbl">Record</span>
      <span style="display:flex;gap:1rem">
        <span class="val ${aWin ? 'win' : ''}">${aRec}</span>
        <span style="color:var(--text3)">vs</span>
        <span class="val ${bWin ? 'win' : ''}">${bRec}</span>
      </span>
    </div>`;
  })();

  const rows = recordRow + [
    cmp(sA.totalPts,     sB.totalPts,     { lbl:'Total PF',           fa:v=>v.toFixed(2), fb:v=>v.toFixed(2) }),
    cmp(sA.avgPts,       sB.avgPts,       { lbl:'Avg / Week',         fa:v=>v.toFixed(2), fb:v=>v.toFixed(2) }),
    cmp(sA.xW,           sB.xW,           { lbl:'Expected Wins (xW)', fa:v=>v.toFixed(3), fb:v=>v.toFixed(3) }),
    cmp(sA.wins - sA.xW, sB.wins - sB.xW, { lbl:'W − xW',             fa:v=>(v>0?'+':'')+v.toFixed(3), fb:v=>(v>0?'+':'')+v.toFixed(3) }),
    cmp(aAllPlayW,       bAllPlayW,       { lbl:'All-Play Wins',      fa:v=>v, fb:v=>v }),
  ].join('');

  const real = realMatchups.length
    ? `<div class="compare-stat-row">
        <span class="lbl">Direct Matchups</span>
        <span class="val">${aActualW}–${bActualW}${ties ? '–'+ties : ''}</span>
      </div>`
    : `<div class="compare-stat-row">
        <span class="lbl">Direct Matchups</span>
        <span class="val" style="color:var(--text3)">none played</span>
      </div>`;

  const realDetail = realMatchups.length
    ? `<div style="margin-top:.5rem;font-size:.75rem;color:var(--text2)">` +
        realMatchups.map(m => {
          const aw = m.aScore > m.bScore;
          return `Wk ${m.week}: <span class="${aw?'positive':'negative'}">${m.aScore.toFixed(2)}</span> – <span class="${aw?'negative':'positive'}">${m.bScore.toFixed(2)}</span>`;
        }).join(' &nbsp;|&nbsp; ') +
      `</div>`
    : '';

  target.innerHTML = `
    <div class="compare-grid">
      <div class="compare-side">
        <div class="team-name" style="font-size:1rem;color:var(--accent)">${esc(tA.name)}</div>
        <div class="owner-name" style="margin-bottom:.75rem">${esc(ownerStr(tA))}</div>
      </div>
      <div class="vs-divider compare-vs">VS</div>
      <div class="compare-side">
        <div class="team-name" style="font-size:1rem;color:var(--accent2)">${esc(tB.name)}</div>
        <div class="owner-name" style="margin-bottom:.75rem">${esc(ownerStr(tB))}</div>
      </div>
    </div>
    <div class="card section-gap" style="background:var(--bg3)">
      ${rows}
      ${real}
      ${realDetail}
    </div>
  `;
}

// ── H2H — Full table toggle ───────────────────────────────────────────────────
window.toggleFullH2H = function() {
  window._fullH2HOpen = !window._fullH2HOpen;
  document.getElementById('full-h2h-area').style.display = window._fullH2HOpen ? '' : 'none';
  document.getElementById('show-full-h2h-btn').textContent =
    window._fullH2HOpen ? 'Hide full table ▴' : 'Show full table ▾';
  document.getElementById('h2h-single-btn').style.display = window._fullH2HOpen ? '' : 'none';
  document.getElementById('h2h-biweek-btn').style.display = window._fullH2HOpen ? '' : 'none';
  if (window._fullH2HOpen) {
    document.getElementById('h2h-single-btn').classList.add('active');
    document.getElementById('h2h-biweek-btn').classList.remove('active');
  }
};

window.showH2H = function(mode) {
  window._h2hMode = mode;
  document.getElementById('h2h-single-btn').classList.toggle('active', mode === 'single');
  document.getElementById('h2h-biweek-btn').classList.toggle('active', mode === 'biweek');
  document.getElementById('h2h-single-wrap').style.display  = mode === 'single'  ? '' : 'none';
  document.getElementById('h2h-biweek-wrap').style.display  = mode === 'biweek'  ? '' : 'none';
};

function renderH2H(mode) {
  const { teams, h2hRecords, biweeklyScores, completedWeeks } = APP;
  const tableId = mode === 'single' ? 'h2h-single-table' : 'h2h-biweek-table';
  const table = document.getElementById(tableId);

  let records;
  if (mode === 'biweek') records = computeBiH2H(teams, biweeklyScores, completedWeeks);
  else                   records = h2hRecords;

  const key = (a, b) => [a, b].sort().join('_');

  const header = `<thead><tr>
    <th>Team</th>
    ${teams.map(t => `<th class="center">${esc(shortName(t))}</th>`).join('')}
    <th class="center">W</th><th class="center">L</th>
  </tr></thead>`;

  const body = teams.map(rowTeam => {
    let totalW = 0, totalL = 0;
    const cells = teams.map(colTeam => {
      if (rowTeam.id === colTeam.id) return `<td class="h2h-cell-diag center">—</td>`;
      const k = key(rowTeam.id, colTeam.id);
      const r = records[k];
      if (!r) return `<td class="center dim">?</td>`;
      const w = r[rowTeam.id] ?? 0;
      const l = r[colTeam.id] ?? 0;
      totalW += w; totalL += l;
      const cls = w > l ? 'h2h-cell-win' : w < l ? 'h2h-cell-loss' : 'dim';
      return `<td class="center ${cls} mono">${w}–${l}</td>`;
    }).join('');
    return `<tr>
      <td><div class="team-name" style="font-size:.85rem">${esc(rowTeam.name)}</div><div class="owner-name">${esc(shortName(rowTeam))}</div></td>
      ${cells}
      <td class="center positive mono">${totalW}</td>
      <td class="center negative mono">${totalL}</td>
    </tr>`;
  }).join('');

  table.innerHTML = header + `<tbody>${body}</tbody>`;
}

function computeBiH2H(teams, biweeklyScores, completedWeeks) {
  const key = (a, b) => [a, b].sort().join('_');
  const records = {};
  teams.forEach(a => teams.forEach(b => {
    if (a.id >= b.id) return;
    records[key(a.id, b.id)] = { [a.id]: 0, [b.id]: 0 };
  }));
  const biweeks = completedWeeks.slice(1);
  biweeks.forEach(w => {
    teams.forEach(a => teams.forEach(b => {
      if (a.id >= b.id) return;
      const k = key(a.id, b.id);
      const sa = biweeklyScores[a.id]?.[w] ?? 0;
      const sb = biweeklyScores[b.id]?.[w] ?? 0;
      if (sa > sb) records[k][a.id]++;
      else if (sb > sa) records[k][b.id]++;
    }));
  });
  return records;
}

// ── Power Rankings ────────────────────────────────────────────────────────────
function renderPowerRankings() {
  const { powerRanks, karma, teams, isHistorical } = APP;
  const maxXW = powerRanks[0]?.xW ?? 1;

  // Hide karma card for historical years (placeholder matchups make karma meaningless)
  document.getElementById('karma-list').closest('.card').style.display = isHistorical ? 'none' : '';

  // xW Power list
  document.getElementById('power-list').innerHTML = powerRanks.map(pr => {
    const pct = (pr.xW / maxXW * 100).toFixed(1);
    const rCls = pr.rank <= 3 ? `r${pr.rank}` : '';
    return `<div class="pr-item">
      <div class="pr-rank ${rCls}">${pr.rank}</div>
      <div class="pr-info">
        <div class="pr-name">${esc(pr.team.name)}</div>
        <div class="pr-owner">${esc(ownerStr(pr.team))}</div>
      </div>
      <div class="pr-bar-wrap">
        <div class="pr-bar-bg"><div class="pr-bar" style="width:${pct}%"></div></div>
        <div class="pr-xw">${pr.xW.toFixed(3)} xW</div>
      </div>
    </div>`;
  }).join('');

  // Schedule Karma list — sorted from luckiest (highest +) to unluckiest (lowest -)
  const karmaList = teams.map(t => ({
    team: t,
    score: karma.karma[t.id] ?? 0,
    luckyWins: karma.luckyWins[t.id] ?? 0,
    heartbreakers: karma.heartbreakers[t.id] ?? 0,
    games: karma.totalGames[t.id] ?? 0,
    weeks: karma.perWeek[t.id] ?? [],
    std: karma.stdScore?.[t.id] ?? 0,
  })).sort((a, b) => b.score - a.score);

  // Superlative team IDs — find the leader for each "title"
  const luckiestId    = karmaList[0]?.team.id;
  const unluckiestId  = karmaList[karmaList.length - 1]?.team.id;
  const boomBustId    = [...karmaList].sort((a, b) => b.std - a.std)[0]?.team.id;
  const mostSteadyId  = [...karmaList].sort((a, b) => a.std - b.std)[0]?.team.id;

  const teamNameById = Object.fromEntries(teams.map(t => [t.id, t.name]));

  document.getElementById('karma-list').innerHTML = karmaList.map((l, i) => {
    const cls = l.score > 0 ? 'positive' : l.score < 0 ? 'negative' : 'neutral';
    const sign = l.score > 0 ? '+' : '';
    const perGame = l.games ? (l.score / l.games) : 0;

    // Per-week breakdown table (hidden until expanded)
    const weeksSorted = [...l.weeks].sort((a, b) => a.week - b.week);
    const weekRows = weeksSorted.map(w => {
      const dCls = w.delta > 0 ? 'positive' : w.delta < 0 ? 'negative' : 'neutral';
      const dSign = w.delta > 0 ? '+' : '';
      const result = w.tied ? 'T' : (w.won ? 'W' : 'L');
      const resCls = w.won ? 'positive' : w.tied ? 'neutral' : 'negative';
      const tag = w.wasLucky      ? `<span class="badge badge-blue" style="margin-left:.5rem">lucky W</span>`
                : w.wasHeartbreak ? `<span class="badge badge-loss" style="margin-left:.5rem">heartbreak L</span>` : '';
      // Z-score colored by magnitude
      const zAbs = Math.abs(w.oppZ ?? 0);
      const zCls = zAbs > 1 ? (w.oppZ > 0 ? 'negative' : 'positive') : 'dim';
      const zSign = (w.oppZ ?? 0) > 0 ? '+' : '';
      return `<tr>
        <td class="mono dim">Wk ${w.week}</td>
        <td class="${resCls} mono center">${result}</td>
        <td>vs ${esc(teamNameById[w.oppId] ?? '?')}</td>
        <td class="mono right">${w.oppScore.toFixed(2)}</td>
        <td class="mono right dim">${w.oppAvg.toFixed(2)} ± ${(w.oppStd ?? 0).toFixed(1)}</td>
        <td class="mono right ${zCls}">${zSign}${(w.oppZ ?? 0).toFixed(2)}σ</td>
        <td class="mono right ${dCls}">${dSign}${w.delta.toFixed(2)}${tag}</td>
      </tr>`;
    }).join('');

    // Superlative tags for this team
    const tags = [];
    if (l.team.id === luckiestId)
      tags.push(`<span class="badge badge-win" title="Highest karma score this season">Luckiest</span>`);
    if (l.team.id === unluckiestId)
      tags.push(`<span class="badge badge-loss" title="Lowest karma score this season">Unluckiest</span>`);
    if (l.team.id === boomBustId)
      tags.push(`<span class="badge badge-gold" title="Highest weekly score variance (σ=${l.std.toFixed(1)})">Boom or Bust</span>`);
    if (l.team.id === mostSteadyId && mostSteadyId !== boomBustId)
      tags.push(`<span class="badge badge-blue" title="Lowest weekly score variance (σ=${l.std.toFixed(1)})">Most Steady</span>`);
    const tagHTML = tags.length
      ? `<span style="display:inline-flex;gap:.35rem;margin-left:.5rem;flex-wrap:wrap">${tags.join('')}</span>`
      : '';

    return `<div class="pr-item karma-row" data-tid="${l.team.id}" style="cursor:pointer">
      <div class="pr-rank" style="font-size:1rem;color:var(--text3)">${i+1}</div>
      <div class="pr-info">
        <div class="pr-name">${esc(l.team.name)}${tagHTML} <span style="font-size:.6rem;color:var(--text3)">▼</span></div>
        <div class="pr-owner">
          <span class="karma-mgr-name">${esc(ownerStr(l.team))} · </span>
          <span class="positive">${l.luckyWins} lucky W</span> ·
          <span class="negative">${l.heartbreakers} heartbreak L</span>
        </div>
      </div>
      <div style="text-align:right">
        <div class="pr-xw ${cls}" style="font-size:1rem">${sign}${l.score.toFixed(1)} pts</div>
        <div style="font-family:var(--font-mono);font-size:.65rem;color:var(--text3)">${(perGame>0?'+':'')}${perGame.toFixed(2)}/game</div>
      </div>
    </div>
    <div class="karma-detail" data-tid="${l.team.id}" style="display:none;background:var(--bg3);border-radius:6px;padding:.6rem .8rem;margin:0 0 .6rem 2.5rem">
      <table style="width:100%;font-size:.78rem">
        <thead>
          <tr style="color:var(--text3)">
            <th style="text-align:left">Wk</th>
            <th>Res</th>
            <th style="text-align:left">Opponent</th>
            <th class="right">Opp Score</th>
            <th class="right">Opp Avg ± σ</th>
            <th class="right">z-score</th>
            <th class="right">Δ (pts)</th>
          </tr>
        </thead>
        <tbody>${weekRows}</tbody>
      </table>
    </div>`;
  }).join('');

  // Wire expand/collapse
  document.querySelectorAll('#karma-list .karma-row').forEach(row => {
    row.addEventListener('click', () => {
      const tid = row.dataset.tid;
      const detail = document.querySelector(`#karma-list .karma-detail[data-tid="${tid}"]`);
      if (!detail) return;
      detail.style.display = detail.style.display === 'none' ? '' : 'none';
    });
  });
}

// ── xW Progression Chart (Scaled) ────────────────────────────────────────
let _xwChart = null;
function renderXWChart() {
  const { teams, weekGroups, pyth } = APP;
  const ctx = document.getElementById('xw-chart').getContext('2d');

  const palette = ['#00d4ff','#ff6b2b','#7fff6b','#f59e0b','#a78bfa','#ec4899','#22c55e','#fbbf24','#60a5fa','#f87171'];

  const datasets = teams.map((t, i) => {
    const data = weekGroups.map(g => pyth.xWCumByWeek[t.id]?.[g.canonicalWeek] ?? 0);
    const weekDeltas = weekGroups.map(g => pyth.xWByWeek[t.id]?.[g.canonicalWeek] ?? 0);
    return {
      label: shortName(t),
      data,
      _weekDeltas: weekDeltas,
      _teamName: t.name,
      borderColor: palette[i % palette.length],
      backgroundColor: palette[i % palette.length] + '22',
      borderWidth: 1,
      tension: 0.25,
      pointRadius: 2,
      pointHoverRadius: 5,
      pointBackgroundColor: palette[i % palette.length],
    };
  });

  if (_xwChart) _xwChart.destroy();
  _xwChart = new Chart(ctx, {
    type: 'line',
    data: { labels: weekGroups.map(g => g.label), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: { display: false }, // we render our own toggle row
        tooltip: {
          backgroundColor: '#10141a',
          borderColor: '#1e2733',
          borderWidth: 1,
          titleColor: '#e8edf5',
          bodyColor: '#e8edf5',
          padding: 12,
          callbacks: {
            title: (items) => items[0]?.label ?? '',
            label: (ctx) => {
              const cum = ctx.parsed.y;
              const delta = ctx.dataset._weekDeltas[ctx.dataIndex] ?? 0;
              const sign = delta >= 0 ? '+' : '';
              return `${ctx.dataset._teamName}: xW = ${cum.toFixed(3)}  (Δ ${sign}${delta.toFixed(3)})`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(30,39,51,.4)' },
          ticks: { color: '#7a8a9e', font: { family: 'DM Mono' } }
        },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(30,39,51,.4)' },
          ticks: { color: '#7a8a9e', font: { family: 'DM Mono' } },
          title: { display: true, text: 'Cumulative Scaled xW', color: '#7a8a9e' }
        }
      }
    }
  });

  // Custom legend toggles
  const legend = document.getElementById('xw-legend');
  legend.innerHTML = teams.map((t, i) =>
    `<button class="on" data-idx="${i}" style="border-color:${palette[i%palette.length]};color:${palette[i%palette.length]}">${esc(shortName(t))}</button>`
  ).join('');
  legend.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.idx);
      const meta = _xwChart.getDatasetMeta(i);
      meta.hidden = !meta.hidden;
      btn.classList.toggle('on', !meta.hidden);
      _xwChart.update();
    });
  });
}

// ── ESPN Power Ranking Chart ──────────────────────────────────────────────────
let _espnChart = null;
function renderESPNPowerChart() {
  const { teams, powerRankings, regWeeks } = APP;
  if (!powerRankings || Object.keys(powerRankings).length === 0) {
    // No data for this season — hide the card and destroy any lingering chart
    document.getElementById('espn-pr-card').style.display = 'none';
    if (_espnChart) { _espnChart.destroy(); _espnChart = null; }
    return;
  }
  document.getElementById('espn-pr-card').style.display = '';

  const weeks = Object.keys(powerRankings).map(Number).sort((a,b)=>a-b);
  const palette = ['#00d4ff','#ff6b2b','#7fff6b','#f59e0b','#a78bfa','#ec4899','#22c55e','#fbbf24','#60a5fa','#f87171'];

  const datasets = teams.map((t, i) => {
    const data = weeks.map(w => {
      const wk = powerRankings[String(w)] ?? [];
      const entry = wk.find(e => e.teamId === t.id);
      return entry ? entry.rank : null;
    });
    return {
      label: shortName(t),
      data,
      _teamName: t.name,
      borderColor: palette[i % palette.length],
      backgroundColor: palette[i % palette.length] + '22',
      borderWidth: 1,
      tension: 0.25,
      pointRadius: 2,
      pointHoverRadius: 5,
      pointBackgroundColor: palette[i % palette.length],
      spanGaps: true,
    };
  });

  const ctx = document.getElementById('espn-pr-chart').getContext('2d');
  if (_espnChart) _espnChart.destroy();
  _espnChart = new Chart(ctx, {
    type: 'line',
    data: { labels: weeks.map(w => `Wk ${w}`), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#10141a',
          borderColor: '#1e2733',
          borderWidth: 1,
          titleColor: '#e8edf5',
          bodyColor: '#e8edf5',
          padding: 12,
          callbacks: {
            label: (ctx) => `${ctx.dataset._teamName}: ESPN Rank #${ctx.parsed.y}`
          }
        }
      },
      scales: {
        x: { grid: { color: 'rgba(30,39,51,.4)' }, ticks: { color: '#7a8a9e', font: { family: 'DM Mono' } } },
        y: {
          reverse: true,           // rank 1 at top
          beginAtZero: false,
          min: 1,
          max: teams.length,
          ticks: { color: '#7a8a9e', font: { family: 'DM Mono' }, stepSize: 1 },
          title: { display: true, text: 'ESPN Rank (1 = best)', color: '#7a8a9e' }
        }
      }
    }
  });

  const legend = document.getElementById('espn-pr-legend');
  legend.innerHTML = teams.map((t, i) =>
    `<button class="on" data-idx="${i}" style="border-color:${palette[i%palette.length]};color:${palette[i%palette.length]}">${esc(shortName(t))}</button>`
  ).join('');
  legend.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.idx);
      const meta = _espnChart.getDatasetMeta(i);
      meta.hidden = !meta.hidden;
      btn.classList.toggle('on', !meta.hidden);
      _espnChart.update();
    });
  });
}

// ── Table sorting + column highlight ──────────────────────────────────────────
function sortTable(tableId, th) {
  const table = document.getElementById(tableId);
  const headers = table.querySelectorAll('thead th');
  const colIdx = [...headers].indexOf(th);
  const wasAsc = th.classList.contains('sort-asc');
  const asc = !wasAsc;
  headers.forEach(h => h.classList.remove('sort-asc', 'sort-desc', 'sort-active', 'col-sorted'));
  th.classList.add(asc ? 'sort-asc' : 'sort-desc', 'sort-active', 'col-sorted');

  const isNumeric = th.dataset.numeric === 'true';
  const rows = [...table.tBodies[0].rows];
  rows.sort((a, b) => {
    const ac = a.cells[colIdx], bc = b.cells[colIdx];
    if (isNumeric) {
      const av = parseFloat(ac?.dataset.val ?? ac?.textContent) || 0;
      const bv = parseFloat(bc?.dataset.val ?? bc?.textContent) || 0;
      return asc ? av - bv : bv - av;
    }
    return asc
      ? String(ac?.textContent ?? '').localeCompare(String(bc?.textContent ?? ''))
      : String(bc?.textContent ?? '').localeCompare(String(ac?.textContent ?? ''));
  });
  rows.forEach(r => table.tBodies[0].appendChild(r));

  // Highlight the column on every row
  [...table.tBodies[0].rows].forEach(r => {
    [...r.cells].forEach((c, i) => c.classList.toggle('col-sorted', i === colIdx));
  });
}

// ── Utility ───────────────────────────────────────────────────────────────────
function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function ownerStr(t) {
  const o = t?.owner;
  if (!o) return t?.name ?? '';
  if (typeof o === 'string') return o;
  if (Array.isArray(o)) return ownerStr({ owner: o[0] });
  if (typeof o === 'object') return `${o.firstName ?? ''} ${o.lastName ?? ''}`.trim();
  return String(o);
}
function shortName(t) { return ownerStr(t).split(' ')[0]; }

// ── Playoff Bracket ─────────────────────────────────────────────────────────
let _bracketShowPredicted = false;
function renderBracket() {
  const { predictedBracket, actualBracket, weekGroups, regWeeks, isHistorical } = APP;
  const playoffsStarted = weekGroups.some(g => g.canonicalWeek > regWeeks);

  // Controls
  const controls = document.getElementById('bracket-controls');
  if (isHistorical) {
    // Historical years: only show actual results, no toggle
    controls.innerHTML = `<span style="font-family:var(--font-mono);font-size:.7rem;color:var(--text3);letter-spacing:1px">ACTUAL PLAYOFF RESULTS</span>`;
  } else if (playoffsStarted && actualBracket) {
    controls.innerHTML = `
      <span style="font-family:var(--font-mono);font-size:.7rem;color:var(--text3);letter-spacing:1px">CURRENTLY VIEWING:</span>
      <button class="week-btn ${!_bracketShowPredicted ? 'active' : ''}" id="bracket-actual-btn">Actual Results</button>
      <button class="week-btn ${_bracketShowPredicted ? 'active' : ''}" id="bracket-pred-btn">Regular-Season Prediction</button>`;
    document.getElementById('bracket-actual-btn').addEventListener('click', () => { _bracketShowPredicted = false; renderBracket(); });
    document.getElementById('bracket-pred-btn').addEventListener('click',   () => { _bracketShowPredicted = true;  renderBracket(); });
  } else {
    controls.innerHTML = `<span style="font-family:var(--font-mono);font-size:.7rem;color:var(--text3);letter-spacing:1px">Predicted from regular-season standings · Tiebreakers: 2-Wk H2H → Direct H2H → PF</span>`;
  }

  const showActual = isHistorical || (playoffsStarted && actualBracket && !_bracketShowPredicted);
  const data = showActual ? actualBracket : predictedBracket;
  document.getElementById('bracket-playoff').innerHTML     = renderBracketSide(data?.playoff,     'playoff',     showActual);
  document.getElementById('bracket-consolation').innerHTML = renderBracketSide(data?.consolation, 'consolation', showActual);
}

function renderBracketSide(side, kind, isActual) {
  if (!side) return `<div style="color:var(--text3);text-align:center;padding:1rem">Bracket not available yet.</div>`;

  // Default seedings used when the predicted bracket hasn't tagged them.
  const defaultSeedsRound1 = kind === 'consolation' ? [[5,6],[7,8]] : [[1,4],[2,3]];

  const teamRow = (team, score, isWinner, seed, finalWinner) => {
    if (!team) return `<div class="bracket-team"><span class="bracket-name dim">TBD</span></div>`;
    const cls = finalWinner ? 'final-winner' : isWinner ? 'winner' : '';
    const seedHtml = seed ? `<span class="bracket-seed">#${seed}</span>` : '';
    const scoreHtml = (score !== undefined && score !== null) ? `<span class="bracket-score">${score.toFixed(2)}</span>` : '';
    return `<div class="bracket-team ${cls}">
      ${seedHtml}<span class="bracket-name">${esc(team.name)}</span>${scoreHtml}
    </div>`;
  };

  const game = (g, opts = {}) => {
    if (!g) return `<div class="bracket-game predicted"><div class="bracket-team"><span class="bracket-name dim">TBD</span></div></div>`;
    const baseCls  = isActual ? '' : 'predicted';
    const finalCls = opts.kind === 'final' ? 'final' : opts.kind === 'third' ? 'third' : '';
    const winnerIsA = g.winner === g.a?.id;
    const winnerIsB = g.winner === g.b?.id;
    const reasonText = isActual ? '' : (g.reason ? `predicted: ${g.reason}` : '');
    return `<div class="bracket-game ${baseCls} ${finalCls}">
      ${teamRow(g.a, isActual ? g.aScore : null, winnerIsA, opts.seedA, opts.kind === 'final' && winnerIsA)}
      ${teamRow(g.b, isActual ? g.bScore : null, winnerIsB, opts.seedB, opts.kind === 'final' && winnerIsB)}
      ${reasonText ? `<div class="bracket-reason">${esc(reasonText)}</div>` : ''}
    </div>`;
  };

  const r1 = side.round1 || [];
  const finalLabel = kind === 'playoff' ? '🏆 Championship' : '5th-Place';
  const thirdLabel = kind === 'playoff' ? '🥉 3rd-Place Game' : '7th-Place Game';
  const seedA1 = r1[0]?.seedA ?? defaultSeedsRound1[0][0];
  const seedB1 = r1[0]?.seedB ?? defaultSeedsRound1[0][1];
  const seedA2 = r1[1]?.seedA ?? defaultSeedsRound1[1][0];
  const seedB2 = r1[1]?.seedB ?? defaultSeedsRound1[1][1];

  return `
    <div class="bracket-tournament">
      <div class="bracket-rd r1">
        ${game(r1[0], { seedA: seedA1, seedB: seedB1 })}
        ${game(r1[1], { seedA: seedA2, seedB: seedB2 })}
      </div>
      <div></div><!-- connector spacer -->
      <div class="bracket-rd r2">
        ${game(side.final, { kind: 'final' })}
      </div>
    </div>
    <div class="bracket-third">
      <div class="bracket-third-label">${thirdLabel}</div>
      ${game(side.thirdGame, { kind: 'third' })}
    </div>`;
}

// ── Trade Analyzer ──────────────────────────────────────────────────────────
function renderTradeAnalyzer() {
  const { trades, teamById } = APP;
  const list = document.getElementById('trades-list');
  if (!trades || !trades.length) {
    list.innerHTML = `<div class="card" style="text-align:center;color:var(--text2);padding:2rem">
      No trades found. If your league had trades, re-run <code>python fetch.py</code> to pull them.
    </div>`;
    return;
  }
  // Sort by date descending (most recent first)
  const sorted = [...trades].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  list.innerHTML = sorted.map((tr, i) => renderTradeCard(tr, i, teamById)).join('');
}

function renderTradeCard(tr, idx, teamById) {
  const dateStr = tr.date ? new Date(tr.date).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'}) : '—';
  const sides = tr.sides || [];
  if (sides.length < 2) return '';
  // Compute "received side" for each: each team got the other team's players
  const playersByTeam = {};
  sides.forEach(s => playersByTeam[s.teamId] = s.players);

  // For 2-team trades, just two sides; for 3-team etc., show pairwise tradeoffs
  const sideHTML = sides.map((s, i) => {
    const team = teamById[s.teamId];
    // What this team RECEIVED = the union of every OTHER side's players
    const received = sides.filter((_, j) => j !== i).flatMap(o => o.players);
    const totalRecv = received.reduce((sum, p) => sum + (p.pointsTotalSeason || 0), 0);
    const playerRows = received.map(p => `
      <div class="trade-player">
        <div>
          <div class="pname">${esc(p.name ?? '—')}</div>
          <div class="pmeta">${esc((p.position ?? '') + (p.proTeam ? ' · ' + p.proTeam : ''))}</div>
        </div>
        <div style="text-align:right">
          <div class="ppts">${(p.pointsTotalSeason ?? 0).toFixed(2)} pts</div>
          <div class="pmeta">season starter pts</div>
        </div>
      </div>`).join('');
    return `<div class="trade-side">
      <h4>${esc(team?.name ?? s.teamName ?? 'Unknown')}</h4>
      <div class="owner-line">${esc(ownerStr(team ?? {}))}</div>
      <div class="got-label">Received (${received.length})</div>
      ${playerRows || '<div style="color:var(--text3);font-size:.78rem">— nothing</div>'}
      <div style="margin-top:.65rem;padding-top:.5rem;border-top:1px solid var(--border);font-family:var(--font-mono);font-size:.8rem;color:var(--text)">
        Total: <strong style="color:var(--accent)">${totalRecv.toFixed(2)} pts</strong>
      </div>
    </div>`;
  });

  // Verdict: who got the better return (only meaningful for 2-team trades)
  let verdict = '';
  if (sides.length === 2) {
    const a = sides[0], b = sides[1];
    const aRecv = b.players.reduce((s, p) => s + (p.pointsTotalSeason || 0), 0);
    const bRecv = a.players.reduce((s, p) => s + (p.pointsTotalSeason || 0), 0);
    const diff = aRecv - bRecv;
    const winnerName = teamById[diff > 0 ? a.teamId : b.teamId]?.name ?? '—';
    const margin = Math.abs(diff);
    if (margin < 5) {
      verdict = `<div class="trade-verdict">⚖️ Roughly even trade — within ${margin.toFixed(2)} season points.</div>`;
    } else {
      verdict = `<div class="trade-verdict">🏆 <strong>${esc(winnerName)}</strong> got the better haul by <strong>${margin.toFixed(2)} season points</strong>.</div>`;
    }
  }

  return `<div class="trade-card">
    <div class="trade-head">
      <div style="font-family:var(--font-display);font-size:1.1rem;letter-spacing:1.5px;color:var(--text)">Trade #${idx + 1}</div>
      <div class="trade-date">${esc(dateStr)}</div>
    </div>
    <div class="trade-sides">
      ${sideHTML[0]}
      <div class="trade-vs">⇄</div>
      ${sideHTML[1] ?? ''}
    </div>
    ${verdict}
  </div>`;
}

// ── Auto-scale tables to fit container on mobile ──────────────────────────────
// On phones/tablets: measure each table's NATURAL width (without the CSS
// width:100% constraint) and scale it down so every column fits the viewport
// without horizontal scrolling. The wrap's height is adjusted to compensate
// for the CSS transform (which doesn't affect document flow).
(function initTableScaling() {
  const isTouchOrSmall = () =>
    window.matchMedia('(max-width: 768px)').matches || 'ontouchstart' in window;
  if (!isTouchOrSmall()) return;

  function scaleTable(wrap) {
    const table = wrap.querySelector('table');
    if (!table) return;

    // Reset any previously-applied inline scaling so we measure cleanly.
    table.style.transform = '';
    table.style.width = '';
    table.style.minWidth = '';
    wrap.style.height = '';

    // Force the table to its NATURAL width so we can measure how wide it
    // actually wants to be. CSS may have set width:100%/min-width:0 which
    // would otherwise force the table to compress and confuse the measurement.
    table.style.width = 'max-content';
    table.style.minWidth = 'max-content';
    // After applying max-content, scrollWidth reports the natural width.
    const tableW = table.scrollWidth;
    const containerW = wrap.clientWidth;

    if (tableW <= containerW) {
      // Already fits — restore default behavior (let CSS govern)
      table.style.width = '';
      table.style.minWidth = '';
      return;
    }

    const scale = containerW / tableW;
    table.style.transform = `scale(${scale})`;
    table.style.transformOrigin = 'top left';
    // Keep the natural width pinned so the transform can shrink it visually.
    table.style.width = `${tableW}px`;
    table.style.minWidth = `${tableW}px`;
    // Adjust the wrap height since transform doesn't affect document flow.
    wrap.style.height = `${table.scrollHeight * scale + 4}px`;
  }
  function scaleAll() {
    document.querySelectorAll('.table-wrap').forEach(scaleTable);
  }
  // Run after renders and on resize. Debounce mutations so we don't thrash.
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; scaleAll(); });
  };
  const mo = new MutationObserver(schedule);
  mo.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  schedule();
})();
