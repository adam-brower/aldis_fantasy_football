"""
fetch.py — Run this locally once a week to refresh your league data.

Usage:
    python fetch.py

Requirements:
    pip install espn-api
"""

import json
import os
from datetime import datetime
from espn_api.football import League

# ── ESPN stat-ID → friendly name (covers what we score against) ───────────────
# Matches espn_api.football.constant.STATS_MAP, hardcoded so older versions of
# the lib (which may have an incomplete map) still work.
STATS_MAP = {
    0: 'passingAttempts', 1: 'passingCompletions', 2: 'passingIncompletions',
    3: 'passingYards', 4: 'passingTouchdowns',
    19: 'passing2PtConversions', 20: 'passingInterceptions',
    23: 'rushingAttempts', 24: 'rushingYards', 25: 'rushingTouchdowns',
    26: 'rushing2PtConversions',
    40: 'receivingReceptions', 41: 'receivingTargets',
    42: 'receivingYards', 43: 'receivingTouchdowns',
    44: 'receiving2PtConversions',
    53: 'receivingReceptions',  # PPR variant in some leagues
    63: 'fumbles', 68: 'fumblesLost', 72: 'lostFumbles',
    74: 'madeFieldGoalsFrom17To19', 77: 'madeFieldGoalsFrom20To29',
    80: 'madeFieldGoalsFrom30To39', 83: 'madeFieldGoalsFrom40To49',
    86: 'madeFieldGoalsFromOver50',
    88: 'extraPoints', 89: 'extraPointAttempts', 93: 'extraPoints',
    95: 'missedFieldGoals',
    96: 'totalPointsAllowed', 97: 'pointsAllowed1To6', 98: 'pointsAllowed7To13',
    99: 'pointsAllowed14To17', 100: 'pointsAllowed18To21', 101: 'pointsAllowed22To27',
    102: 'pointsAllowed28To34', 103: 'pointsAllowed35To45', 104: 'pointsAllowed46Plus',
    106: 'sacks', 107: 'fumblesRecoveredByDefense', 108: 'interceptions',
    109: 'safeties', 110: 'touchdownsByDefense',
    113: 'blockedFGTouchdowns', 114: 'blockedPuntTouchdowns',
    115: 'blockedPunts', 116: 'blockedPats',
    123: 'puntReturnTouchdowns', 124: 'kickReturnTouchdowns',
}
STAT_NAME_TO_ID = {name: sid for sid, name in STATS_MAP.items()}

POSITION_MAP = {
    0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 16: 'D/ST', 17: 'K',
}
POS_NAME_TO_ID = {name: pid for pid, name in POSITION_MAP.items()}

# ── Config ────────────────────────────────────────────────────────────────────
# Credentials are read from environment variables first (for GitHub Actions CI),
# falling back to the hardcoded values below (for running locally).
#
# To refresh espn_s2 and SWID from your browser:
#   1. Go to fantasy.espn.com and log in
#   2. DevTools → Application → Cookies → fantasy.espn.com
#   3. Copy espn_s2 and SWID values
#   4. Update below AND in GitHub repo Settings → Secrets → Actions

LEAGUE_ID = 12705243
YEAR      = int(os.environ.get("YEAR", 2025))
ESPN_S2   = os.environ.get("ESPN_S2")
SWID      = os.environ.get("SWID")

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print(f"Fetching ESPN data for league {LEAGUE_ID}, season {YEAR}...")

    league = League(
        league_id=LEAGUE_ID,
        year=YEAR,
        espn_s2=ESPN_S2,
        swid=SWID,
    )

    print(f"  ✓ Connected to: {league.settings.name}")

    # ── Teams ─────────────────────────────────────────────────────────────────
    print("  → Parsing teams...")
    teams = []
    for t in league.teams:
        teams.append({
            "id":            t.team_id,
            "name":          t.team_name,
            "abbrev":        t.team_abbrev,
            "owner":         f"{t.owners[0].get('firstName','')} {t.owners[0].get('lastName','')}".strip() if t.owners else "Unknown",
            "wins":          t.wins,
            "losses":        t.losses,
            "ties":          t.ties,
            "pointsFor":     t.points_for,
            "pointsAgainst": t.points_against,
            "playoffSeed":   t.playoff_pct,
        })

    # ── Build league scoring rules: stat_id → multiplier (with position overrides) ─
    # league.settings.scoring_format is a list like:
    #   [{'abbr': 'PY', 'label': 'Passing Yards', 'points': 0.04, 'id': 3,
    #     'points_overrides': {0: 0.04, ...}}, ...]
    print("  → Parsing scoring rules...")
    scoring_rules = {}  # { stat_id: {'default','overrides','label','abbr'} }
    try:
        for rule in (getattr(league.settings, "scoring_format", None) or []):
            sid = rule.get("id") if isinstance(rule, dict) else getattr(rule, "id", None)
            if sid is None: continue
            pts   = rule.get("points") if isinstance(rule, dict) else getattr(rule, "points", 0)
            label = rule.get("label")  if isinstance(rule, dict) else getattr(rule, "label", None)
            abbr  = rule.get("abbr")   if isinstance(rule, dict) else getattr(rule, "abbr", None)
            ovr_raw = (rule.get("points_overrides") if isinstance(rule, dict)
                       else getattr(rule, "points_overrides", {})) or {}
            overrides = { int(k): float(v) for k, v in ovr_raw.items() }
            scoring_rules[int(sid)] = {
                "default": float(pts or 0),
                "overrides": overrides,
                "label": label or STATS_MAP.get(int(sid)) or f"Stat {sid}",
                "abbr":  abbr or "",
            }
    except Exception as e:
        print(f"     ⚠ Could not parse scoring rules: {e}")
    print(f"     {len(scoring_rules)} scoring rules loaded")

    def compute_breakdown(raw_stats, position):
        """For each league scoring rule, find the raw value (by numeric ID or
        friendly name) and multiply by the multiplier. Returns (breakdown, raw)
        both keyed by the rule's label so the JS can pair them up trivially."""
        if not scoring_rules: return {}, {}
        pid = POS_NAME_TO_ID.get(position)

        breakdown = {}
        raw_by_label = {}

        for sid, rule in scoring_rules.items():
            # 1) try numeric-ID key in raw_stats
            val = raw_stats.get(str(sid))
            # 2) try friendly-name key
            if val is None:
                friendly = STATS_MAP.get(sid)
                if friendly:
                    val = raw_stats.get(friendly)
            if val is None or val == 0:
                continue

            mult = rule["overrides"].get(pid, rule["default"]) if pid is not None else rule["default"]
            pts = float(val) * mult
            if abs(pts) < 0.001:
                continue

            label = rule["label"]
            breakdown[label]    = round(breakdown.get(label, 0) + pts, 4)
            raw_by_label[label] = val
        return breakdown, raw_by_label

    # ── Schedule (all completed weeks) ────────────────────────────────────────
    print("  → Parsing schedule...")
    schedule = {}

    def serialize_player(p, week_num):
        """Turn a BoxPlayer into a JSON-friendly dict (with per-stat breakdown)."""
        breakdown_from_lib = {}
        raw_stats = {}
        try:
            week_blob = (getattr(p, "stats", {}) or {}).get(week_num, {}) or {}
            breakdown_from_lib = week_blob.get("points_breakdown") or {}
            raw_stats = week_blob.get("breakdown") or {}
            breakdown_from_lib = {k: float(v) for k, v in breakdown_from_lib.items() if v not in (None, 0)}
            raw_stats = {k: float(v) for k, v in raw_stats.items() if v not in (None, 0)}
        except Exception:
            pass

        # Always compute from scoring rules — older espn_api versions leave
        # points_breakdown empty for box-score players, and even when populated
        # it can miss things like sack penalties.
        breakdown, raw_by_label = compute_breakdown(raw_stats, getattr(p, "position", None))

        return {
            "name":      getattr(p, "name", None),
            "proTeam":   getattr(p, "proTeam", None),
            "position":  getattr(p, "position", None),
            "slot":      getattr(p, "slot_position", None),
            "points":    float(getattr(p, "points", 0) or 0),
            "projected": float(getattr(p, "projected_points", 0) or 0),
            "breakdown": breakdown,    # { 'Passing Yards': +5.65, 'Times Sacked': -3.0 }
            "rawStats":  raw_by_label, # { 'Passing Yards': 113, 'Times Sacked': 3 }
        }

    for week in range(1, league.current_week + 1):
        box_scores = league.box_scores(week)
        week_matchups = []
        for b in box_scores:
            home_team = b.home_team
            away_team = b.away_team
            is_bye = away_team == 0  # espn-api returns 0 for bye weeks

            home_lineup = [serialize_player(p, week) for p in (getattr(b, "home_lineup", []) or [])]
            away_lineup = [] if is_bye else [serialize_player(p, week) for p in (getattr(b, "away_lineup", []) or [])]

            # ── True single-week scores from starter lineup totals ────────────
            # ESPN's box_scores(week).home_score returns the CUMULATIVE 2-week
            # total for playoff weeks that span a 2-week round (e.g. Wks 16+17),
            # but each BoxPlayer.points IS the single-week value. So we sum the
            # starters to get the actual single-week team score and override
            # any cumulative-as-single-week garbage from the API.
            BENCH_SLOTS = {"BE", "Bench", "IR", "IR/RES"}
            def starter_total(lineup):
                return round(sum(p.get("points", 0) or 0 for p in lineup
                                 if p.get("slot") not in BENCH_SLOTS), 2)

            home_score_single = starter_total(home_lineup) if home_lineup else b.home_score
            away_score_single = starter_total(away_lineup) if away_lineup and not is_bye else (
                b.away_score if not is_bye else 0)

            week_matchups.append({
                "week":            week,
                "homeTeamId":      home_team.team_id if home_team != 0 else None,
                "awayTeamId":      away_team.team_id if not is_bye else None,
                "homeScore":       home_score_single,                # corrected single-week
                "awayScore":       away_score_single,                # corrected single-week
                "homeScoreApi":    b.home_score,                     # original API value (kept for reference)
                "awayScoreApi":    b.away_score if not is_bye else 0,
                "isBye":           is_bye,
                "homeLineup":      home_lineup,
                "awayLineup":      away_lineup,
            })
        schedule[str(week)] = week_matchups
        print(f"     Week {week}: {len(week_matchups)} matchups")

    # ── Settings ──────────────────────────────────────────────────────────────
    settings = {
        "name":               league.settings.name,
        "playoffTeamCount":   league.settings.playoff_team_count,
        "regularSeasonWeeks": league.settings.reg_season_count,
        "teamCount":          league.settings.team_count,
        "combineWeeks":       [[16, 17]],  # 2025 structure: Wk 15 alone, Wks 16+17 combined
    }

    # ── ESPN Power Rankings (per week) ────────────────────────────────────────
    # The espn_api library exposes league.power_rankings(week) which returns
    # a list of (rank_score_str, team) tuples ordered best→worst.
    print("  → Fetching ESPN power rankings per week...")
    power_rankings = {}
    for week in range(1, league.current_week + 1):
        try:
            pr = league.power_rankings(week=week)
            week_rankings = []
            for rank_idx, (score, t) in enumerate(pr):
                week_rankings.append({
                    "teamId": t.team_id,
                    "rank":   rank_idx + 1,
                    "score":  float(score) if score is not None else None,
                })
            power_rankings[str(week)] = week_rankings
            print(f"     PR Week {week}: {len(week_rankings)} entries")
        except Exception as e:
            print(f"     PR Week {week}: skipped ({e})")

    # ── Trades — pull league.recent_activity() and filter to trades ───────────
    # Each Activity has .actions = [(team, action_str, player, bid_amount), ...]
    # For trades, action_str == 'TRADED' and players are split across two teams.
    print("  → Fetching league trades...")
    trades = []
    try:
        # ESPN's recent_activity returns most-recent-first and caps the page size.
        # We page through with offset to walk the full season's worth of activity.
        activities = []
        BATCH_SIZE = 25
        MAX_TOTAL  = 2000  # safety cap
        offset_val = 0
        seen_signatures = set()
        while offset_val < MAX_TOTAL:
            batch = []
            # Try once filtered, once unfiltered — older espn_api versions can ignore
            # the msg_type filter and the unfiltered call still works.
            for fetch_call in (
                lambda: league.recent_activity(size=BATCH_SIZE, msg_type="TRADED", offset=offset_val),
                lambda: league.recent_activity(size=BATCH_SIZE, offset=offset_val),
            ):
                try:
                    batch = fetch_call() or []
                    if batch: break
                except TypeError:
                    continue
                except Exception:
                    continue
            if not batch:
                break
            new_added = 0
            for a in batch:
                # Stable signature so we can stop when we start seeing repeats
                sig = (getattr(a, "date", None), len(getattr(a, "actions", []) or []),
                       tuple((getattr(t,"team_id",None), str(act_str), getattr(p,"name",None))
                             for t, act_str, p, *_ in (getattr(a, "actions", []) or []) if t))
                if sig in seen_signatures: continue
                seen_signatures.add(sig)
                activities.append(a)
                new_added += 1
            print(f"     activity batch offset={offset_val} got {len(batch)} ({new_added} new)")
            if new_added == 0:
                break
            offset_val += BATCH_SIZE
        print(f"     total activities pulled: {len(activities)}")

        # Count action types so we can see what's coming back
        action_type_counts = {}
        for act in activities:
            for entry in (getattr(act, "actions", []) or []):
                if len(entry) > 1:
                    s = str(entry[1]).upper()
                    action_type_counts[s] = action_type_counts.get(s, 0) + 1
        print(f"     activity action types: {action_type_counts}")

        for act in activities:
            actions = getattr(act, "actions", []) or []
            # Group players by team — each side of the trade
            sides = {}  # { team_id: { teamId, teamName, players: [] } }
            is_trade = False
            for entry in actions:
                # Each entry is roughly (team, action_str, player) — sometimes 4-tuple
                if not entry: continue
                t = entry[0]
                action_str = str(entry[1]) if len(entry) > 1 else ""
                p = entry[2] if len(entry) > 2 else None
                if "TRADED" not in action_str.upper():
                    continue
                is_trade = True
                if t is None or t == 0: continue
                tid = getattr(t, "team_id", None)
                if tid is None: continue
                sides.setdefault(tid, {
                    "teamId": tid,
                    "teamName": getattr(t, "team_name", None),
                    "players": [],
                })
                if p is not None:
                    sides[tid]["players"].append({
                        "name":     getattr(p, "name", None),
                        "position": getattr(p, "position", None),
                        "proTeam":  getattr(p, "proTeam", None),
                        "playerId": getattr(p, "playerId", None),
                    })
            if not is_trade or len(sides) < 2: continue
            # Date / week processing
            ts = getattr(act, "date", None)
            iso = None
            wk = None
            try:
                from datetime import datetime as _dt
                if ts:
                    # espn_api gives ms-since-epoch
                    dt = _dt.fromtimestamp(ts / 1000)
                    iso = dt.isoformat()
                    # Week = best-effort: NFL season starts ~Sept 1; map to 1-17
                    # We'll let the JS compute "week of trade" if needed.
            except Exception:
                pass
            trades.append({
                "date": iso,
                "ts":   ts,
                "sides": list(sides.values()),
            })
        print(f"     {len(trades)} trades found")
    except Exception as e:
        print(f"     ⚠ Could not fetch trades: {e}")
        trades = []

    # ── For trade analysis: add post-trade points for each player ─────────────
    # Walk every player on every roster across the season; collect total points
    # by playerId so the JS can sum points scored on each team after the trade.
    print("  → Indexing player points by playerId for trade analysis...")
    player_total_points = {}   # { playerId: total_pts_in_lineup_starts }
    player_team_points  = {}   # { playerId: { teamId: total_pts_starts_for_that_team } }
    for week_str, matchups in schedule.items():
        for m in matchups:
            for side, lineup_key, team_id_key in (("home", "homeLineup", "homeTeamId"),
                                                   ("away", "awayLineup", "awayTeamId")):
                lineup = m.get(lineup_key) or []
                tid = m.get(team_id_key)
                if not lineup or tid is None: continue
                for p in lineup:
                    pid = p.get("playerId")
                    pts = float(p.get("points", 0) or 0)
                    if pid is None: continue
                    if p.get("slot") in ("BE", "Bench", "IR", "IR/RES"):
                        continue  # only count starters
                    player_total_points[pid] = player_total_points.get(pid, 0) + pts
                    player_team_points.setdefault(pid, {})[tid] = \
                        player_team_points.get(pid, {}).get(tid, 0) + pts
    # Attach the totals to each trade-side player record so the JS can render them
    for tr in trades:
        for side in tr["sides"]:
            for p in side["players"]:
                pid = p.get("playerId")
                if pid is None: continue
                p["pointsTotalSeason"] = round(player_total_points.get(pid, 0), 2)
                p["pointsByTeam"]      = {str(k): round(v, 2)
                                          for k, v in (player_team_points.get(pid, {}) or {}).items()}

    # ── Sanity-check: do the computed breakdowns sum to player.points? ────────
    print("  → Verifying breakdown math...")
    mismatches = 0
    samples = 0
    for week_str, matchups in schedule.items():
        for m in matchups:
            for p in (m.get("homeLineup") or []) + (m.get("awayLineup") or []):
                if not p.get("breakdown") or p.get("slot") in ("BE", "IR"):
                    continue
                total = sum(p["breakdown"].values())
                actual = p.get("points") or 0
                samples += 1
                if abs(total - actual) > 0.5 and abs(actual) > 0.1:
                    mismatches += 1
                    if mismatches <= 3:
                        print(f"     ⚠ {p['name']} W{week_str}: computed {total:.2f} vs actual {actual:.2f}")
    print(f"     {samples - mismatches}/{samples} starters reconcile within 0.5 pts")

    # ── Output ────────────────────────────────────────────────────────────────
    output = {
        "lastUpdated":    datetime.now().isoformat(),
        "season":         YEAR,
        "leagueId":       LEAGUE_ID,
        "settings":       settings,
        "scoringRules":   scoring_rules,
        "teams":          teams,
        "schedule":       schedule,
        "powerRankings":  power_rankings,
        "trades":         trades,
    }

    # Write to data/{year}.json (primary) and data.json (backward compat)
    os.makedirs("data", exist_ok=True)
    year_path = f"data/{YEAR}.json"
    with open(year_path, "w") as f:
        json.dump(output, f, indent=2)

    with open("data.json", "w") as f:
        json.dump(output, f, indent=2)

    print(f"\n✅ {year_path} saved! ({len(teams)} teams, {len(schedule)} weeks)")
    print("\nNext steps:")
    print("  git add data/ data.json")
    print("  git commit -m 'Update league data'")
    print("  git push")

if __name__ == "__main__":
    import sys
    # Allow --year flag to override: python fetch.py --year 2024
    if "--year" in sys.argv:
        idx = sys.argv.index("--year")
        if idx + 1 < len(sys.argv):
            YEAR = int(sys.argv[idx + 1])
    main()