"""
generate_historical.py — Converts CSV data from previous_data/ into
data/2023.json and data/2024.json in the same format the site expects.

Usage:
    python generate_historical.py
"""

import csv
import json
import os
from datetime import datetime


def read_csv(path):
    """Read a CSV with BOM handling."""
    with open(path, encoding='utf-8-sig') as f:
        return list(csv.DictReader(f))


def build_season(year, config):
    """Build a data.json-compatible dict for a historical season."""
    reg_weeks = config["regularSeasonWeeks"]
    combine_weeks = config["combineWeeks"]

    # ── Teams ─────────────────────────────────────────────────────────────────
    teams_csv = read_csv(f"previous_data/teams_{year}.csv")
    teams = []
    for row in teams_csv:
        tid = int(row["id"])
        total_wins = int(row["totalwins"])
        total_losses = int(row["totallosses"])
        playoff_wins = int(row.get("playoffwins", 0))
        playoff_losses = int(row.get("playofflosses", 0))
        reg_wins = total_wins - playoff_wins
        reg_losses = total_losses - playoff_losses
        teams.append({
            "id": tid,
            "name": row["name"],
            "abbrev": row["abbrev"],
            "owner": row["owner"],
            "wins": reg_wins,
            "losses": reg_losses,
            "ties": 0,
            "pointsFor": 0,       # will be computed from scores
            "pointsAgainst": 0,   # will be computed from schedule
            "playoffSeed": int(row.get("playoffseed", 0)),
            "totalWins": total_wins,
            "totalLosses": total_losses,
        })

    # ── Scores ────────────────────────────────────────────────────────────────
    scores_csv = read_csv(f"previous_data/scores_{year}.csv")
    # Build { teamId: { week: score } }
    weekly_scores = {}
    for row in scores_csv:
        tid = int(row["teamid"])
        week = int(row["week"])
        score = float(row["score"])
        if tid not in weekly_scores:
            weekly_scores[tid] = {}
        weekly_scores[tid][week] = score

    all_weeks = sorted(set(w for ts in weekly_scores.values() for w in ts.keys()))

    # ── Build Schedule (synthetic matchups) ───────────────────────────────────
    # We don't have direct matchup pairings for regular season, so we create
    # "bye-style" entries where each team plays against a placeholder.
    # BUT we DO have bracket data for playoffs — use that for playoff weeks.

    # Parse bracket to get playoff matchup pairings
    bracket_csv = read_csv(f"previous_data/bracket_{year}.csv")

    # Bracket CSV uses playoff seeds as IDs — map seed → actual team ID
    seed_to_team = {t["playoffSeed"]: t["id"] for t in teams}

    # Map: (round, label) → { team1id, team1score, team2id, team2score }
    bracket_matchups = []
    for row in bracket_csv:
        seed1 = int(row["team1id"])
        seed2 = int(row["team2id"])
        bracket_matchups.append({
            "round": int(row["round"]),
            "label": row["label"],
            "team1Id": seed_to_team[seed1],
            "team1Score": float(row["team1score"]),
            "team2Id": seed_to_team[seed2],
            "team2Score": float(row["team2score"]),
        })

    # Determine which weeks are in each playoff round
    # Round 1 = first combineWeeks group, Round 2 = second
    round1_weeks = combine_weeks[0]  # e.g. [15, 16] for 2023
    round2_weeks = combine_weeks[1]  # e.g. [17, 18] for 2023

    # Build playoff pairings from bracket
    round1_pairs = [b for b in bracket_matchups if b["round"] == 1]
    round2_pairs = [b for b in bracket_matchups if b["round"] == 2]

    # For playoff weeks, we need to figure out per-week scores from combined totals
    # We have individual week scores in scores CSV, so we can use those directly
    def build_playoff_week_matchups(pairs, weeks_in_round):
        """Build matchup entries for each individual week in a playoff round."""
        week_matchups = {}
        for w in weeks_in_round:
            wm = []
            for pair in pairs:
                t1 = pair["team1Id"]
                t2 = pair["team2Id"]
                s1 = weekly_scores.get(t1, {}).get(w, 0)
                s2 = weekly_scores.get(t2, {}).get(w, 0)
                wm.append({
                    "week": w,
                    "homeTeamId": t1,
                    "awayTeamId": t2,
                    "homeScore": s1,
                    "awayScore": s2,
                    "homeScoreApi": s1,
                    "awayScoreApi": s2,
                    "isBye": False,
                    "homeLineup": [],
                    "awayLineup": [],
                })
            week_matchups[w] = wm
        return week_matchups

    playoff_matchups = {}
    playoff_matchups.update(build_playoff_week_matchups(round1_pairs, round1_weeks))
    playoff_matchups.update(build_playoff_week_matchups(round2_pairs, round2_weeks))

    # For regular season weeks, we don't know pairings — so we won't create
    # fake h2h matchups. Instead, store each team's score in a matchup against
    # "unknown" (awayTeamId = None). The site will display scores but skip
    # win/loss calculations that require pairings.
    # ACTUALLY: The site's stats engine needs real pairings to compute xW properly.
    # Since we only have scores, we'll create placeholder matchups but mark them
    # so the site knows not to derive matchup-level stats from them.
    # Best approach: put all teams in "solo" entries — site will still compute
    # weekly extremes, xW (all-play), etc. from scores alone.

    schedule = {}
    for w in all_weeks:
        if w in playoff_matchups:
            schedule[str(w)] = playoff_matchups[w]
        else:
            # Regular season: create 4 matchups pairing teams arbitrarily
            # (we don't know real pairings, but the score data is accurate)
            # Pair as: 1v2, 3v4, 5v6, 7v8 (placeholder — doesn't affect xW/extremes)
            team_ids = sorted(weekly_scores.keys())
            matchups = []
            for i in range(0, len(team_ids), 2):
                t1 = team_ids[i]
                t2 = team_ids[i + 1] if i + 1 < len(team_ids) else None
                s1 = weekly_scores.get(t1, {}).get(w, 0)
                s2 = weekly_scores.get(t2, {}).get(w, 0) if t2 else 0
                matchups.append({
                    "week": w,
                    "homeTeamId": t1,
                    "awayTeamId": t2,
                    "homeScore": s1,
                    "awayScore": s2,
                    "homeScoreApi": s1,
                    "awayScoreApi": s2,
                    "isBye": t2 is None,
                    "homeLineup": [],
                    "awayLineup": [],
                })
            schedule[str(w)] = matchups

    # ── Compute PF from scores ────────────────────────────────────────────────
    for t in teams:
        tid = t["id"]
        pf = sum(weekly_scores.get(tid, {}).get(w, 0) for w in all_weeks)
        t["pointsFor"] = round(pf, 2)
        # PA not available for reg season (no real matchups), set to 0
        t["pointsAgainst"] = 0

    # ── Power Rankings (2024 only) ────────────────────────────────────────────
    power_rankings = {}
    pr_path = f"previous_data/power_rankings_{year}.csv"
    if os.path.exists(pr_path):
        pr_csv = read_csv(pr_path)
        for row in pr_csv:
            w = str(int(row["week"]))
            if w not in power_rankings:
                power_rankings[w] = []
            power_rankings[w].append({
                "teamId": int(row["teamid"]),
                "rank": int(row["rank"]),
                "score": None,  # no score data in CSV
            })

    # ── Settings ──────────────────────────────────────────────────────────────
    settings = {
        "name": "Nonchalant Fantasy Football",
        "playoffTeamCount": 4,
        "regularSeasonWeeks": reg_weeks,
        "teamCount": 8,
        "combineWeeks": combine_weeks,
    }

    # ── Output ────────────────────────────────────────────────────────────────
    output = {
        "lastUpdated": datetime.now().isoformat(),
        "season": year,
        "leagueId": 12705243,
        "settings": settings,
        "scoringRules": {},
        "teams": teams,
        "schedule": schedule,
        "powerRankings": power_rankings,
        "trades": [],
    }

    return output


def main():
    os.makedirs("data", exist_ok=True)

    # 2023: reg season 1-14, round 1 = Wks 15+16, finals = Wks 17+18
    config_2023 = {
        "regularSeasonWeeks": 14,
        "combineWeeks": [[15, 16], [17, 18]],
    }
    data_2023 = build_season(2023, config_2023)
    with open("data/2023.json", "w") as f:
        json.dump(data_2023, f, indent=2)
    print("✅ data/2023.json saved!")

    # 2024: reg season 1-13, round 1 = Wks 14+15, finals = Wks 16+17
    config_2024 = {
        "regularSeasonWeeks": 13,
        "combineWeeks": [[14, 15], [16, 17]],
    }
    data_2024 = build_season(2024, config_2024)
    with open("data/2024.json", "w") as f:
        json.dump(data_2024, f, indent=2)
    print("✅ data/2024.json saved!")


if __name__ == "__main__":
    main()
