# MeetBeats

**A music bot for Google Meet** -- like a Discord music bot, but for Meet.

![Node.js](https://img.shields.io/badge/Node.js-20-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-Chromium-2EAD33?logo=playwright&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-yellow)

MeetBeats joins a Google Meet call as a bot participant, monitors the chat for commands, and streams YouTube audio to all participants through a virtual microphone. Anyone in the meeting can request songs, manage the queue, and control playback -- all through the Meet chat.

## Features

- **Play from YouTube** -- search by name or paste a URL
- **Playlist support** -- queue an entire YouTube playlist at once
- **Shared queue** -- anyone in the meeting can add, remove, skip, or shuffle songs
- **Playback controls** -- pause, resume, skip, stop, and loop (song or queue)
- **Real-time volume** -- adjust volume on the fly via PulseAudio sink control
- **Auto-leave** -- bot leaves automatically when it's the last participant
- **Graceful shutdown** -- Ctrl+C cleanly leaves the meeting before exiting
- **Fully containerized** -- runs entirely in Docker, no host audio setup needed

## Architecture

```
Docker Container
+---------------------------------------------------------------+
|                                                               |
|   Xvfb (virtual display :99)                                 |
|     +------------------------------------------------------+  |
|     |  Playwright (Chromium)                                |  |
|     |    +- Google Meet tab                                 |  |
|     |    |    Chat monitor <--- reads commands              |  |
|     |    |    WebRTC mic   <--- meetbeats_mic (virtual mic)  |  |
|     |    |    WebRTC spkr  ---> chrome_output (isolated)    |  |
|     +------------------------------------------------------+  |
|                                                               |
|   PulseAudio                                                  |
|     meetbeats_sink  <--- ffmpeg writes audio here             |
|       .monitor ---------> meetbeats_mic (remap-source)        |
|     chrome_output   <--- Chrome speaker (prevents echo)      |
|                                                               |
|   yt-dlp            <--- downloads YouTube audio              |
|   ffmpeg            <--- decodes + streams to PulseAudio      |
|   Node.js (bot.ts)  <--- orchestrates everything              |
|                                                               |
+---------------------------------------------------------------+
```

**Why PulseAudio?** Google Meet captures audio from the browser's microphone. MeetBeats creates a virtual mic fed by ffmpeg through a PulseAudio pipeline. Chrome's speaker output goes to an isolated sink to prevent echo loops.

## Commands

All commands are sent in the Google Meet chat. Both `!` and `/` prefixes work.

| Command | Description |
|---------|-------------|
| `!play <url or search>` | Play a song (YouTube URL or search query) |
| `!playlist <url>` | Queue all songs from a YouTube playlist |
| `!skip` | Skip the current song |
| `!stop` | Stop playback and clear the queue |
| `!pause` | Pause the current song |
| `!resume` | Resume playback |
| `!queue` | Show the current queue |
| `!np` | Show what's currently playing |
| `!volume <0-100>` | Set playback volume |
| `!shuffle` | Shuffle the queue |
| `!loop` | Toggle loop mode (off / song / queue) |
| `!remove <position>` | Remove a song from the queue by position |
| `!help` | Show all available commands |
| `!exit` | Bot leaves the meeting |

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- A Google account for the bot to sign in with

## Quick Start

### 1. Clone the repo

```bash
git clone https://github.com/Andymendez100/MeetBeats.git
cd MeetBeats
```

### 2. Set up authentication

The bot needs a logged-in Google session. Run the auth setup script to sign in via a real browser and save the session:

```bash
npm install
npm run setup-auth
```

This opens Chromium -- sign into Google, then close the browser. Session state is saved to `auth/`.

### 3. Run

```bash
./meetbeats https://meet.google.com/abc-defg-hij
```

The image builds automatically on first run. The bot joins the meeting and announces itself in chat. Press **Ctrl+C** to leave.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MEET_URL` | *(required)* | Google Meet URL to join |
| `GOOGLE_EMAIL` | | Google account email (for reference) |
| `BOT_NAME` | `MeetBeats` | Display name for the bot |
| `COMMAND_PREFIX` | `!` | Prefix for chat commands |
| `DEFAULT_VOLUME` | `50` | Initial volume (0-100) |
| `LOG_LEVEL` | `info` | Logging verbosity (`debug`, `info`, `warn`, `error`) |

## How It Works

1. **Browser automation** -- Playwright launches Chromium inside a virtual display (Xvfb) and navigates to Google Meet. It handles joining the call, dismissing popups, and monitoring the chat DOM for new messages.

2. **Audio pipeline** -- When a song is requested, yt-dlp downloads the audio from YouTube. ffmpeg decodes the file and streams it into a PulseAudio null sink (`meetbeats_sink`). The sink's monitor is remapped as a virtual microphone (`meetbeats_mic`) that Chrome picks up as its mic input and sends to all participants via WebRTC.

3. **Echo isolation** -- Chrome's speaker output is routed to a separate sink (`chrome_output`) so received audio doesn't loop back into the virtual mic.

4. **Volume control** -- The bot adjusts PulseAudio sink volume in real-time with `pactl`, so volume changes take effect immediately without restarting playback.

5. **Signal handling** -- Bash job control isolates Chrome from Ctrl+C signals. When SIGINT arrives, the entrypoint forwards SIGTERM to Node.js only, keeping Chrome alive so the shutdown handler can navigate away from Meet before closing the browser.

## Tech Stack

| Component | Role |
|-----------|------|
| **Node.js 20** | Runtime |
| **TypeScript** | Language |
| **Playwright** | Browser automation (Chromium) |
| **yt-dlp** | YouTube download |
| **ffmpeg** | Audio decoding and PulseAudio output |
| **PulseAudio** | Virtual audio routing |
| **Xvfb** | Headless display server |
| **Docker** | Containerization |

## Project Structure

```
src/
  bot.ts                  # Main bot orchestrator and lifecycle
  index.ts                # Entry point
  audio/
    AudioPlayer.ts        # ffmpeg playback via PulseAudio
    QueueManager.ts       # Song queue with shuffle/loop
    types.ts              # Song type definition
  commands/
    CommandParser.ts      # Chat message -> command parser
    handlers.ts           # Command implementations
  meet/
    MeetManager.ts        # Playwright browser + Meet interaction
    ChatMonitor.ts        # DOM-based chat message polling
    selectors.ts          # Google Meet CSS selectors
  youtube/
    YouTubeService.ts     # yt-dlp search and metadata
    Downloader.ts         # yt-dlp audio download
  utils/
    config.ts             # Environment variable config
    logger.ts             # Winston logger
docker/
  Dockerfile              # Multi-stage build with all dependencies
  docker-compose.yml      # Service definition
  entrypoint.sh           # Xvfb + PulseAudio setup + signal handling
  pulse-default.pa        # PulseAudio config
```

## License

MIT
