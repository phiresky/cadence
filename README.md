# Cadence

A PWA that plays music and synchronizes the playback BPM to your walking steps per minute in real-time.

## How it works

1. Load any audio file from your device
2. Set the track's original BPM (tap the button rhythmically or type it in)
3. Hit the sync button to start step detection
4. Walk — the app detects your steps via the accelerometer and adjusts the music tempo to match your cadence

## Features

- Real-time step detection via DeviceMotion API
- Smooth playback rate adjustment with configurable limits
- Tap-to-detect BPM
- Media Session API for lock screen controls
- Offline support via service worker
- Installable as a PWA
- Desktop simulation mode (spacebar = step) for testing

## Disclaimer

This project was vibe coded with Claude Code (Claude Opus 4.6). The code has not been manually reviewed or audited. Use at your own risk.
