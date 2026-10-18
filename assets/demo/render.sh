#!/usr/bin/env bash
# Squeeze a raw review recording into the README GIF. The start plays in real time, the
# minutes of agents working are sped up, and the report arriving plays at double speed
# before holding on its last frame.
#
#   bash assets/demo/render.sh <raw.mp4> <out.gif> <report_at_s> [speedup]
#
# <report_at_s> is when the report file appeared, in seconds into the video; record.sh
# measures it. [speedup] plays the whole cut that many times faster (default 5); the hold on
# the last frame stays long enough to read it. Re-run this alone to re-cut a recording.
set -euo pipefail

IN="$1"
OUT="$2"
REPORT_AT="$3"
SPEEDUP="${4:-5}"
HOLD=4         # seconds the final frame stays, after the speed-up
HEAD=12        # typing the command, the panel starting: real time
MIDDLE=16      # the agents working, sped up to this many seconds
BEFORE=20      # report time window, before and after the file appears...
AFTER=20
TAIL_SPEED=2   # ...played at this speed

DUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$IN")"
TAIL_START="$(echo "$REPORT_AT - $BEFORE" | bc -l)"
TAIL_END="$(echo "e=$REPORT_AT + $AFTER; if (e > $DUR) $DUR else e" | bc -l)"
SPEED="$(echo "($TAIL_START - $HEAD) / $MIDDLE" | bc -l)"

ffmpeg -v error -y -i "$IN" -filter_complex "
  [0:v]trim=0:$HEAD,setpts=PTS-STARTPTS[a];
  [0:v]trim=$HEAD:$TAIL_START,setpts=(PTS-STARTPTS)/$SPEED[b];
  [0:v]trim=$TAIL_START:$TAIL_END,setpts=(PTS-STARTPTS)/$TAIL_SPEED[c];
  [a][b][c]concat=n=3,setpts=PTS/$SPEEDUP,tpad=stop_mode=clone:stop_duration=$HOLD,fps=12,split[x][y];
  [x]palettegen=stats_mode=diff[p];
  [y][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle
" "$OUT"

echo "$OUT: $(du -h "$OUT" | cut -f1), middle sped up $(echo "scale=0; $SPEED / 1" | bc)x"
