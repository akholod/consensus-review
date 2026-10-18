#!/usr/bin/env bash
# Record the README demo: a real /consensus-review of the demo repository, captured with VHS
# and squeezed into a ~50s GIF. Needs vhs, ffmpeg, bc, claude, and codex (logged in).
#
#   bash assets/demo/record.sh [max_minutes]   # writes assets/demo.gif
#   bash assets/demo/record.sh probe           # one screenshot of the first visible frame, no review
#
# Run it from a normal terminal, not from inside Claude Code: a real review takes several
# minutes and spends real model calls (the Opus agents and codex).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROBE=""
[ "${1:-}" = probe ] && PROBE=1 && shift
MAX_MIN="${1:-15}"
WORK="$(mktemp -d)"
DEMO="$WORK/shop-demo"
bash "$ROOT/assets/demo/setup.sh" "$DEMO"

# VHS cannot wait for the end of the review: Wait+Screen reads the top of the buffer, not the
# rows on screen, so it never sees output that has scrolled. The recording runs for a fixed
# time instead, and the moment the report file appears is logged here for render.sh to cut on.
cat > "$WORK/demo.tape" <<EOF
Output "$WORK/raw.mp4"
Set Shell bash
Set FontSize 15
Set Width 1260
Set Height 720
Set Padding 12
Set Framerate 12
Set TypingSpeed 60ms
Set Theme "Catppuccin Mocha"

# Start Claude off camera; /clear drops the welcome banner (it shows the account).
Hide
Type "cd '$DEMO' && export PS1='\$ ' && clear" Enter
# Drop session markers inherited when this script runs under another Claude Code session.
Type "for v in \$(env | grep -oE '^CLAUDE[A-Z_]*' | grep -v AGENT_TEAMS); do unset \$v; done; clear" Enter
Type "date +%s > '$WORK/launched'; claude --permission-mode acceptEdits --effort high" Enter
Sleep 12s
# The folder-trust prompt defaults to "No, exit": move to "Yes" first.
Down
Sleep 500ms
Enter
Sleep 6s
Type "/clear" Sleep 500ms Enter
Sleep 3s
Show

Sleep 1s
# The slash-command menu opens on "/" and drops keys typed while it renders.
Type "/"
Sleep 1500ms
# The full name: for bare "consensus-review" the menu's first match is consensus-review:doctor,
# and Enter takes the highlighted match.
Type@120ms "consensus-review:consensus-review"
Sleep 2s
EOF

if [ -n "$PROBE" ]; then
  cat >> "$WORK/demo.tape" <<EOF
Screenshot "$ROOT/assets/demo/probe.png"
Sleep 2s
Ctrl+U
Type "/exit" Sleep 500ms Enter
Sleep 2s
EOF
  vhs "$WORK/demo.tape"
  echo "probe: $ROOT/assets/demo/probe.png"
  exit 0
fi

cat >> "$WORK/demo.tape" <<EOF
Enter
Sleep ${MAX_MIN}m
EOF

( while ! compgen -G "$DEMO/.reviews/review-*.md" > /dev/null; do sleep 1; done
  date +%s > "$WORK/reported" ) &
WATCH=$!
vhs "$WORK/demo.tape"
kill "$WATCH" 2>/dev/null || true

if [ ! -s "$WORK/reported" ]; then
  echo "no report within ${MAX_MIN} minutes; raise it: bash $0 <max_minutes>. Raw: $WORK/raw.mp4" >&2
  exit 1
fi
# The visible part starts ~23s after launch: the hidden Sleeps and typing above.
REPORT_AT=$(( $(cat "$WORK/reported") - $(cat "$WORK/launched") - 23 ))
bash "$ROOT/assets/demo/render.sh" "$WORK/raw.mp4" "$ROOT/assets/demo.gif" "$REPORT_AT"
echo "raw recording kept at $WORK/raw.mp4 (report at ${REPORT_AT}s)"
