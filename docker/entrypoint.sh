#!/bin/bash
set -e

echo "=== MeetBeats Container Starting ==="

# Start Xvfb (virtual display)
echo "Starting Xvfb..."
Xvfb :99 -screen 0 1280x720x24 -ac &
export DISPLAY=:99

# Force SDL-based tools (like ffplay) to use PulseAudio
export SDL_AUDIODRIVER=pulse

# Wait for Xvfb to be ready
sleep 1

# Start PulseAudio in user mode (suppress root warning — it's fine in Docker)
echo "Starting PulseAudio..."
HOME=/root pulseaudio --start --exit-idle-time=-1 --load="module-native-protocol-unix auth-anonymous=1" 2>&1 || true
sleep 1

# Verify PulseAudio is running
if pulseaudio --check 2>/dev/null; then
  echo "PulseAudio: running"
else
  echo "ERROR: PulseAudio failed to start!"
  exit 1
fi

# Set up virtual audio devices
echo "Configuring virtual audio..."

# 1. Music sink — ffmpeg plays audio here (targeted via PULSE_SINK env var)
#    Use 48kHz to match ffmpeg output and avoid resampling artifacts
pactl load-module module-null-sink sink_name=meetbeats_sink sink_properties=device.description="MeetBeats_Music" rate=48000

# 2. Separate output sink for Chrome's speaker audio.
#    Without this, Chrome's received audio goes to meetbeats_sink → leaks into the
#    monitor → Chrome reads it back as mic input → WebRTC echo canceller kills our music.
pactl load-module module-null-sink sink_name=chrome_output sink_properties=device.description="Chrome_Output"

# 3. Virtual mic from the music sink's monitor (captures only ffmpeg's music, no echo)
pactl load-module module-remap-source master=meetbeats_sink.monitor source_name=meetbeats_mic source_properties=device.description="MeetBeats_Mic"

# 4. Chrome uses chrome_output for speakers (default sink) and meetbeats_mic for mic (default source).
#    ffmpeg bypasses the default sink by explicitly targeting meetbeats_sink via PULSE_SINK.
pactl set-default-sink chrome_output
pactl set-default-source meetbeats_mic

# 5. Max out volumes on the music pipeline to avoid quiet output
pactl set-sink-volume meetbeats_sink 65536
pactl set-source-volume meetbeats_mic 65536
pactl set-source-volume meetbeats_sink.monitor 65536

echo ""
echo "=== Audio Configuration ==="
echo "Sinks:"
pactl list short sinks
echo "Sources:"
pactl list short sources
echo "Default sink: $(pactl get-default-sink 2>/dev/null || echo unknown)"
echo "Default source: $(pactl get-default-source 2>/dev/null || echo unknown)"

# Verify ffmpeg has PulseAudio support
if ffmpeg -hide_banner -devices 2>&1 | grep -q pulse; then
  echo "ffmpeg PulseAudio output: supported"
else
  echo "WARNING: ffmpeg may not have PulseAudio support"
fi

# Test the audio pipeline with a brief tone
echo ""
echo "Testing audio pipeline..."
if ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "sine=frequency=440:duration=0.5" \
  -f pulse -ac 1 -ar 48000 "test_tone" 2>/dev/null; then
  echo "Audio pipeline test: OK (ffmpeg -> PulseAudio)"
else
  echo "WARNING: ffmpeg -f pulse failed, testing paplay fallback..."
  ffmpeg -y -hide_banner -loglevel error \
    -f lavfi -i "sine=frequency=440:duration=0.5" \
    -f wav /tmp/test_tone.wav 2>/dev/null
  if paplay --device=meetbeats_sink /tmp/test_tone.wav 2>/dev/null; then
    echo "Fallback (paplay) test: OK"
  else
    echo "ERROR: Both audio output methods failed!"
  fi
  rm -f /tmp/test_tone.wav
fi

# Update yt-dlp to latest (YouTube changes break older versions)
echo "Updating yt-dlp..."
pip3 install --break-system-packages -q --upgrade yt-dlp 2>/dev/null || echo "WARNING: yt-dlp update failed, using bundled version"

echo ""
echo "=== Starting MeetBeats Bot ==="

# Job control puts background jobs in their own process group.
# When Ctrl+C sends SIGINT to the foreground group, only bash (PID 1) gets it —
# Chrome stays alive so node's shutdown handler can navigate away from Meet first.
set -m 2>/dev/null || true

node dist/index.js "$@" &
NODE_PID=$!

cleanup() {
  # Send SIGTERM to node only (not Chrome) — node's handler will leave the meeting
  kill -TERM $NODE_PID 2>/dev/null
  # Give node time to click leave and close browser gracefully
  local i=0
  while kill -0 $NODE_PID 2>/dev/null && [ $i -lt 10 ]; do
    sleep 1
    i=$((i + 1))
  done
  # If still alive, force kill the entire process group
  kill -KILL -$NODE_PID 2>/dev/null || true
  exit 0
}

trap cleanup SIGINT SIGTERM
wait $NODE_PID
