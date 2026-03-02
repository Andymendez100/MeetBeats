#!/bin/bash
set -e

echo "=== MeetBeats Container Starting ==="

# Start Xvfb (virtual display)
echo "Starting Xvfb..."
Xvfb :99 -screen 0 1280x720x24 -ac &
export DISPLAY=:99

# Wait for Xvfb to be ready
sleep 1

# Start PulseAudio with our custom config
echo "Starting PulseAudio..."
pulseaudio --start --load="module-native-protocol-unix" --exit-idle-time=-1 --daemon
sleep 1

# Set up the virtual audio device
echo "Configuring virtual audio..."
pactl load-module module-null-sink sink_name=meetbeats_sink sink_properties=device.description="MeetBeats_Virtual_Mic"
pactl set-default-source meetbeats_sink.monitor
pactl set-default-sink meetbeats_sink

echo "Audio devices:"
pactl list short sinks
pactl list short sources

echo "=== Starting MeetBeats Bot ==="
exec node dist/index.js "$@"
