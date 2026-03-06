import { ParsedCommand } from './CommandParser.js';
import { AudioPlayer } from '../audio/AudioPlayer.js';
import { QueueManager } from '../audio/QueueManager.js';
import { YouTubeService } from '../youtube/YouTubeService.js';
import { Downloader } from '../youtube/Downloader.js';
import { MeetManager } from '../meet/MeetManager.js';
import { logger } from '../utils/logger.js';
import { config } from '../utils/config.js';
import { Song } from '../audio/types.js';

export interface HandlerDeps {
  audioPlayer: AudioPlayer;
  queueManager: QueueManager;
  youtubeService: YouTubeService;
  downloader: Downloader;
  meetManager: MeetManager;
  onExit?: () => void;
  onAutoplayTrigger?: () => void;
}

type Handler = (cmd: ParsedCommand, deps: HandlerDeps) => Promise<void>;

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
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
      await reply(deps, `Downloading: ${song.title}`);
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
      await reply(deps, `Usage: ${config.commandPrefix}play <url or search term>`);
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
      await reply(deps, `Searching: ${cmd.args}`);
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
    await deps.audioPlayer.stop();
    const next = deps.queueManager.advance();
    if (next) {
      await playNextInQueue(deps);
    } else {
      await reply(deps, 'Queue is empty.');
    }
  },

  async stop(_cmd, deps) {
    await deps.audioPlayer.stop();
    deps.queueManager.clear();
    await reply(deps, 'Playback stopped and queue cleared.');
  },

  async pause(_cmd, deps) {
    await deps.audioPlayer.pause();
    await reply(deps, 'Paused.');
  },

  async resume(_cmd, deps) {
    await deps.audioPlayer.resume();
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
      await reply(deps, `Usage: ${config.commandPrefix}volume <0-100>`);
      return;
    }
    deps.audioPlayer.setVolume(vol);
    await reply(deps, `Volume set to ${vol}%.`);
  },

  async playlist(cmd, deps) {
    if (!cmd.args) {
      await reply(deps, `Usage: ${config.commandPrefix}playlist <youtube playlist url>`);
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

  async autoplay(_cmd, deps) {
    const enabled = deps.queueManager.toggleAutoplay();
    await reply(deps, `Autoplay: ${enabled ? 'ON — will keep playing related songs' : 'OFF'}`);

    // If toggled on and nothing is playing, kick off autoplay immediately
    if (enabled && !deps.audioPlayer.isPlaying() && !deps.audioPlayer.isPaused() && deps.onAutoplayTrigger) {
      deps.onAutoplayTrigger();
    }
  },

  async remove(cmd, deps) {
    const pos = parseInt(cmd.args, 10);
    if (isNaN(pos) || pos < 1) {
      await reply(deps, `Usage: ${config.commandPrefix}remove <position>`);
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
    const prefix = config.commandPrefix;
    const helpText = [
      'MeetBeats Commands (use ! or /):',
      `${prefix}play <url|search> - Play a song`,
      `${prefix}skip - Skip current song`,
      `${prefix}stop - Stop and clear queue`,
      `${prefix}pause / ${prefix}resume - Pause/resume`,
      `${prefix}queue - Show queue`,
      `${prefix}np - Now playing`,
      `${prefix}volume <0-100> - Set volume`,
      `${prefix}playlist <url> - Queue a playlist`,
      `${prefix}shuffle - Shuffle queue`,
      `${prefix}loop - Toggle loop (off/song/queue)`,
      `${prefix}autoplay - Auto-play related songs when queue ends`,
      `${prefix}remove <pos> - Remove from queue`,
      `${prefix}exit - Bot leaves the meeting`,
    ].join('\n');

    await reply(deps, helpText);
  },

  async exit(_cmd, deps) {
    await reply(deps, 'Bye! 👋');
    if (deps.onExit) deps.onExit();
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
    await reply(deps, `Error executing ${config.commandPrefix}${cmd.command}`);
  }
}

export { playNextInQueue };
