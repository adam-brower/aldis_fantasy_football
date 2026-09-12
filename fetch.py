"""
fetch.py - Refresh the league data the site reads.

Pulls a season from ESPN and writes data/{year}.json (plus data.json for
backward compatibility). Run it locally once a week during the season, or let
the GitHub Action in .github/workflows/ run it every Tuesday morning.

Usage:
    python fetch.py                  # current season
    python fetch.py --year 2024      # a past season
    python fetch.py --help           # full options

Requirements:
    pip install espn-api
"""

import argparse
import getpass
import json
import os
import sys
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

DEFAULT_LEAGUE_ID = 12705243

# Filled in by configure() from the command line / environment. They stay
# module-level because main() and its helpers read them directly.
LEAGUE_ID = DEFAULT_LEAGUE_ID
YEAR      = None
ESPN_S2   = None
SWID      = None

# Local credential file, kept next to this script and out of git. Written only
# if you ask for it at the prompt; GitHub Actions never sees or needs it.
ENV_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")


def load_env_file(path=ENV_FILE):
    """Read simple KEY=VALUE lines from .env into a dict.

    Real environment variables always win over this file, so a value exported
    in the shell (or injected by GitHub Actions) is never shadowed by a stale
    local copy.
    """
    values = {}
    if not os.path.exists(path):
        return values
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                values[key.strip()] = val.strip().strip('"').strip("'")
    except OSError as err:
        print(f"  ! could not read {os.path.basename(path)}: {err}")
    return values


def save_env_file(values, path=ENV_FILE):
    """Merge values into .env (0600) and make sure git ignores it."""
    existing = load_env_file(path)
    existing.update(values)
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write("# Local credentials for fetch.py. Not committed - see .gitignore.\n")
            for key in ("YEAR", "LEAGUE_ID", "ESPN_S2", "SWID"):
                if existing.get(key):
                    f.write(f"{key}={existing[key]}\n")
        os.chmod(path, 0o600)
    except OSError as err:
        print(f"  ! could not write {os.path.basename(path)}: {err}")
        return

    ensure_gitignored(os.path.basename(path))
    print(f"  saved to {os.path.basename(path)} - future local runs won't ask again")


def ensure_gitignored(name):
    """Append name to .gitignore if it isn't covered already."""
    root = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(root, ".gitignore")
    try:
        body = ""
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                body = f.read()
        if name in body.split():
            return
        with open(path, "a", encoding="utf-8") as f:
            if body and not body.endswith("\n"):
                f.write("\n")
            f.write(f"{name}\n")
        print(f"  added {name} to .gitignore")
    except OSError as err:
        print(f"  ! could not update .gitignore ({err}) - add {name} to it yourself")


def is_interactive():
    """True only when a human is actually sitting at the terminal.

    GitHub Actions sets CI and gives the step no tty, so an automated run never
    stops to ask - it fails loudly instead.
    """
    if os.environ.get("CI"):
        return False
    try:
        return sys.stdin.isatty() and sys.stderr.isatty()
    except (AttributeError, ValueError):
        return False


def default_season(today=None):
    """The season currently in play.

    An NFL season spans two calendar years - the 2025 season runs from
    September 2025 into February 2026 - so anything before August belongs to
    the previous season's year.
    """
    today = today or datetime.now()
    return today.year if today.month >= 8 else today.year - 1


def build_parser():
    parser = argparse.ArgumentParser(
        prog="fetch.py",
        description=(
            "Fetch one season of league data from ESPN and write it to "
            "data/{year}.json (and data.json). Run this, then commit the "
            "result - the site reads those files directly and never calls "
            "ESPN from the browser."
        ),
        epilog=(
            "settings are resolved in this order:\n"
            "  command line -> environment -> .env file -> interactive prompt\n"
            "\n"
            "  On GitHub Actions the repo secrets arrive as environment\n"
            "  variables, so a scheduled run resolves everything silently and\n"
            "  never blocks. Run it yourself in a terminal and anything missing\n"
            "  is prompted for, with the option to remember it in .env\n"
            "  (gitignored, chmod 600).\n"
            "\n"
            "environment variables:\n"
            "  ESPN_S2, SWID   Login cookies. Required for a private league.\n"
            "                  Get them from fantasy.espn.com: DevTools ->\n"
            "                  Application -> Cookies -> fantasy.espn.com.\n"
            "  YEAR            Season to fetch, if --year is not passed.\n"
            "  LEAGUE_ID       League to fetch, if --league-id is not passed.\n"
            "  CI              If set, never prompt (fail on missing values).\n"
            "\n"
            "examples:\n"
            "  python fetch.py                   fetch the current season\n"
            "  python fetch.py --year 2024       backfill a past season\n"
            "  python fetch.py --year 2024 --dry-run\n"
            "                                    check credentials, write nothing\n"
            "\n"
            "note: data/survivor.json is hand-maintained and is never touched\n"
            "      by this script.\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "-y", "--year", type=int, metavar="YYYY",
        help="season to fetch (default: $YEAR, else the season in play now)",
    )
    parser.add_argument(
        "-l", "--league-id", type=int, metavar="ID",
        help=f"ESPN league id (default: $LEAGUE_ID, else {DEFAULT_LEAGUE_ID})",
    )
    parser.add_argument(
        "-n", "--dry-run", action="store_true",
        help="fetch and report, but do not write any files",
    )
    parser.add_argument(
        "--no-prompt", action="store_true",
        help="never ask interactively; fail if a credential is missing",
    )
    parser.add_argument(
        "--skip-records", action="store_true",
        help=(
            "keep the wins/losses/ties already on disk instead of overwriting "
            "them with ESPN's current values; scores/schedule/etc still refresh "
            "normally. Used by the Mon/Fri workflow runs so team records only "
            "change once the week closes on the Tuesday run."
        ),
    )
    return parser


def configure(args):
    """Resolve settings, in order: command line, environment, .env, then ask.

    In GitHub Actions the repo secrets (ESPN_S2, SWID, YEAR) arrive as
    environment variables, so everything resolves silently and the run never
    blocks. Locally, anything still missing is prompted for.
    """
    global LEAGUE_ID, YEAR, ESPN_S2, SWID

    file_env = load_env_file()

    def lookup(key):
        return os.environ.get(key) or file_env.get(key)

    def source_of(key):
        return "env" if os.environ.get(key) else ".env"

    interactive = is_interactive() and not args.no_prompt
    prompted = {}
    missing = []

    # ── Season ────────────────────────────────────────────────────────────────
    env_year = lookup("YEAR")
    if args.year is not None:
        YEAR, source = args.year, "--year"
    elif env_year:
        try:
            YEAR = int(env_year)
        except ValueError:
            sys.exit(f"YEAR must be a 4-digit year, got {env_year!r}")
        source = f"${{YEAR}} ({source_of('YEAR')})"
    else:
        guess = default_season()
        if interactive:
            answer = input(f"Season year [{guess}]: ").strip()
            YEAR = int(answer) if answer.isdigit() else guess
            if answer.isdigit():
                prompted["YEAR"] = str(YEAR)
            source = "prompt"
        else:
            YEAR, source = guess, "current season"

    if YEAR < 2000 or YEAR > datetime.now().year + 1:
        sys.exit(f"{YEAR} does not look like a season year (from {source})")

    # ── League ────────────────────────────────────────────────────────────────
    env_league = lookup("LEAGUE_ID")
    if args.league_id is not None:
        LEAGUE_ID = args.league_id
    elif env_league:
        try:
            LEAGUE_ID = int(env_league)
        except ValueError:
            sys.exit(f"LEAGUE_ID must be a number, got {env_league!r}")

    # ── Credentials ───────────────────────────────────────────────────────────
    for key in ("ESPN_S2", "SWID"):
        value = lookup(key)
        if value:
            globals()[key] = value
            continue
        if interactive:
            value = getpass.getpass(f"{key} (paste from your browser cookies, hidden): ").strip()
            if value:
                globals()[key] = value
                prompted[key] = value
            else:
                missing.append(key)
        else:
            missing.append(key)

    if missing and not interactive:
        sys.exit(
            "Missing " + ", ".join(missing) + ".\n"
            "  In GitHub Actions: add them under Settings -> Secrets and variables\n"
            "    -> Actions, and pass them through as env: in the workflow.\n"
            "  Locally: run this from a terminal and it will prompt you, or export\n"
            "    them first, or put them in a .env file next to fetch.py."
        )
    if missing:
        print("  ! " + ", ".join(missing) + " left blank - this only works if the league is public.")

    # ── Offer to remember what we just asked for ─────────────────────────────
    if prompted and interactive:
        answer = input(f"Save these to {os.path.basename(ENV_FILE)} so you aren't asked again? [y/N]: ")
        if answer.strip().lower().startswith("y"):
            save_env_file(prompted)

    return source


# ── Main ──────────────────────────────────────────────────────────────────────

def main(source="", dry_run=False, skip_records=False):
    label = f" (from {source})" if source else ""
    print(f"Fetching ESPN data for league {LEAGUE_ID}, season {YEAR}{label}...")

    league = League(
        league_id=LEAGUE_ID,
        year=YEAR,
        espn_s2=ESPN_S2,
        swid=SWID,
    )

    print(f"  ✓ Connected to: {league.settings.name}")

    # ── Teams ─────────────────────────────────────────────────────────────────
    print("  → Parsing teams...")

    # When --skip-records is set (the Mon/Fri workflow runs), the win/loss/tie
    # columns are frozen at whatever's already committed for this season, so
    # standings only move on the Tuesday run once the week is officially over.
    # Everything else (scores, schedule, power rankings, etc.) still refreshes.
    frozen_records = {}
    if skip_records:
        existing_path = f"data/{YEAR}.json"
        try:
            with open(existing_path, encoding="utf-8") as f:
                existing_data = json.load(f)
            for et in existing_data.get("teams", []):
                frozen_records[et["id"]] = {
                    "wins":   et.get("wins"),
                    "losses": et.get("losses"),
                    "ties":   et.get("ties"),
                }
            print(f"     --skip-records: loaded {len(frozen_records)} teams' records from {existing_path}")
        except FileNotFoundError:
            print(f"     --skip-records: no {existing_path} yet, using live ESPN records for this run")
        except (json.JSONDecodeError, KeyError) as e:
            print(f"     ⚠ --skip-records: could not read {existing_path} ({e}); using live ESPN records")

    teams = []
    for t in league.teams:
        frozen = frozen_records.get(t.team_id)
        teams.append({
            "id":            t.team_id,
            "name":          t.team_name,
            "abbrev":        t.team_abbrev,
            "owner":         f"{t.owners[0].get('firstName','')} {t.owners[0].get('lastName','')}".strip() if t.owners else "Unknown",
            "wins":          frozen["wins"]   if frozen else t.wins,
            "losses":        frozen["losses"] if frozen else t.losses,
            "ties":          frozen["ties"]   if frozen else t.ties,
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

    year_path = f"data/{YEAR}.json"

    if dry_run:
        print(f"\n(dry run) would write {year_path} and data.json "
              f"- {len(teams)} teams, {len(schedule)} weeks")
        return

    # Write to data/{year}.json (primary) and data.json (backward compat)
    os.makedirs("data", exist_ok=True)
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
    args = build_parser().parse_args()
    source = configure(args)
    main(source=source, dry_run=args.dry_run, skip_records=args.skip_records)