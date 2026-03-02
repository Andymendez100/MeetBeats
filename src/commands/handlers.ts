import { ParsedCommand } from './CommandParser.js';
import { AudioPlayer } from '../audio/AudioPlayer.js';
import { QueueManager } from '../audio/QueueManager.js';
import { YouTubeService } from '../youtube/YouTubeService.js';
import { Downloader } from '../youtube/Downloader.js';
import { MeetManager } from '../meet/MeetManager.js';
import { logger } from '../utils/logger.js';
import { Song } from '../audio/types.js';

export interface HandlerDeps {
  audioPlayer: AudioPlayer;
  queueManager: QueueManager;
  youtubeService: YouTubeService;
  downloader: Downloader;
  meetManager: MeetManager;
}

type Handler = (cmd: ParsedCommand, deps: HandlerDeps) => Promise<void>;

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

async function reply(deps: HandlerDeps, message: string): Promise<void> {
  try {
    await deps.meetManager.sendChatMessage(message);
  } catch (err) {
    logger.warn(`Failed to send chat message: ${err}`);
  }
}

async function playNextInQueue(deps: HandlerDeps): Promise<void> {
  const song = deps.queueManager.current();
  if (!song) return;

  try {
    // Download if needed
    if (!song.filePath) {
      song.filePath = await deps.downloader.download(song.url);
    }

    await reply(deps, `Now playing: ${song.title} [${formatDuration(song.duration)}]`);
    await deps.audioPlayer.play(song.filePath);
  } catch (err) {
    logger.error(`Failed to play ${song.title}: ${err}`);
    await reply(deps, `Failed to play: ${song.title}`);
    // Skip to next
    const next = deps.queueManager.advance();
    if (next) await playNextInQueue(deps);
  }
}

const handlers: Record<string, Handler> = {
  async play(cmd, deps) {
    if (!cmd.args) {
      await reply(deps, 'Usage: !play <url or search term>');
      return;
    }

    let song: Song;
    // Check if it's a URL
    if (cmd.args.startsWith('http')) {
      const info = await deps.youtubeService.getInfo(cmd.args);
      if (!info) {
        await reply(deps, 'Could not get video info.');
        return;
      }
      song = { ...info, requestedBy: cmd.sender };
    } else {
      // Search
      const result = await deps.youtubeService.search(cmd.args);
      if (!result) {
        await reply(deps, `No results found for: ${cmd.args}`);
        return;
      }
      song = { ...result, requestedBy: cmd.sender };
    }

    const position = deps.queueManager.add(song);
    const isPlaying = deps.audioPlayer.isPlaying();

    if (!isPlaying) {
      await playNextInQueue(deps);
    } else {
      await reply(deps, `Queued #${position}: ${song.title} [${formatDuration(song.duration)}]`);
    }
  },

  async skip(_cmd, deps) {
    deps.audioPlayer.stop();
    const next = deps.queueManager.advance();
    if (next) {
      await playNextInQueue(deps);
    } else {
      await reply(deps, 'Queue is empty.');
    }
  },

  async stop(_cmd, deps) {
    deps.audioPlayer.stop();
    deps.queueManager.clear();
    await reply(deps, 'Playback stopped and queue cleared.');
  },

  async pause(_cmd, deps) {
    deps.audioPlayer.pause();
    await reply(deps, 'Paused.');
  },

  async resume(_cmd, deps) {
    deps.audioPlayer.resume();
    await reply(deps, 'Resumed.');
  },

  async queue(_cmd, deps) {
    const songs = deps.queueManager.getQueue();
    const currentIdx = deps.queueManager.getCurrentIndex();

    if (songs.length === 0) {
      await reply(deps, 'Queue is empty.');
      return;
    }

    const lines = songs.map((s, i) => {
      const marker = i === currentIdx ? '>' : ' ';
      return `${marker} ${i + 1}. ${s.title} [${formatDuration(s.duration)}] (${s.requestedBy})`;
    });

    await reply(deps, `Queue:\n${lines.join('\n')}`);
  },

  async nowplaying(_cmd, deps) {
    const song = deps.queueManager.current();
    if (!song) {
      await reply(deps, 'Nothing is playing.');
      return;
    }
    await reply(deps, `Now playing: ${song.title} [${formatDuration(song.duration)}] (requested by ${song.requestedBy})`);
  },

  async volume(cmd, deps) {
    const vol = parseInt(cmd.args, 10);
    if (isNaN(vol) || vol < 0 || vol > 100) {
      await reply(deps, 'Usage: !volume <0-100>');
      return;
    }
    deps.audioPlayer.setVolume(vol);
    await reply(deps, `Volume set to ${vol}%.`);
  },

  async playlist(cmd, deps) {
    if (!cmd.args) {
      await reply(deps, 'Usage: !playlist <youtube playlist url>');
      return;
    }

    await reply(deps, 'Loading playlist...');
    const songs = await deps.youtubeService.getPlaylist(cmd.args);
    if (!songs || songs.length === 0) {
      await reply(deps, 'Could not load playlist or playlist is empty.');
      return;
    }

    let added = 0;
    for (const song of songs) {
      deps.queueManager.add({ ...song, requestedBy: cmd.sender });
      added++;
    }

    await reply(deps, `Added ${added} songs from playlist.`);

    if (!deps.audioPlayer.isPlaying()) {
      await playNextInQueue(deps);
    }
  },

  async shuffle(_cmd, deps) {
    deps.queueManager.shuffle();
    await reply(deps, 'Queue shuffled.');
  },

  async loop(_cmd, deps) {
    const mode = deps.queueManager.toggleLoop();
    await reply(deps, `Loop mode: ${mode}`);
  },

  async remove(cmd, deps) {
    const pos = parseInt(cmd.args, 10);
    if (isNaN(pos) || pos < 1) {
      await reply(deps, 'Usage: !remove <position>');
      return;
    }

    const removed = deps.queueManager.remove(pos - 1);
    if (removed) {
      await reply(deps, `Removed: ${removed.title}`);
    } else {
      await reply(deps, `Invalid position: ${pos}`);
    }
  },

  async help(_cmd, deps) {
    const helpText = [
      'MeetBeats Commands:',
      '!play <url|search> - Play a song',
      '!skip - Skip current song',
      '!stop - Stop and clear queue',
      '!pause / !resume - Pause/resume',
      '!queue - Show queue',
      '!np - Now playing',
      '!volume <0-100> - Set volume',
      '!playlist <url> - Queue a playlist',
      '!shuffle - Shuffle queue',
      '!loop - Toggle loop (off/song/queue)',
      '!remove <pos> - Remove from queue',
    ].join('\n');

    await reply(deps, helpText);
  },
};

// Alias
handlers.np = handlers.nowplaying;

export async function handleCommand(cmd: ParsedCommand, deps: HandlerDeps): Promise<void> {
  const handler = handlers[cmd.command];
  if (!handler) {
    logger.warn(`No handler for command: ${cmd.command}`);
    return;
  }

  logger.info(`Handling command: ${cmd.command} from ${cmd.sender}`);
  try {
    await handler(cmd, deps);
  } catch (err) {
    logger.error(`Error handling command ${cmd.command}: ${err}`);
    await reply(deps, `Error executing !${cmd.command}`);
  }
}

export { playNextInQueue };
