import { MeetManager } from './meet/MeetManager.js';
import { ChatMonitor, ChatMessage } from './meet/ChatMonitor.js';
import { parseCommand } from './commands/CommandParser.js';
import { handleCommand, playNextInQueue, HandlerDeps } from './commands/handlers.js';
import { AudioPlayer } from './audio/AudioPlayer.js';
import { QueueManager } from './audio/QueueManager.js';
import { YouTubeService } from './youtube/YouTubeService.js';
import { Downloader } from './youtube/Downloader.js';
import { logger } from './utils/logger.js';
import { config } from './utils/config.js';

export class MeetBeatsBot {
  private meetManager: MeetManager;
  private chatMonitor: ChatMonitor;
  private audioPlayer: AudioPlayer;
  private queueManager: QueueManager;
  private youtubeService: YouTubeService;
  private downloader: Downloader;
  private deps: HandlerDeps;
  private shutdownResolve: (() => void) | null = null;
  private participantCheckInterval: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;

  constructor() {
    this.meetManager = new MeetManager();
    this.chatMonitor = new ChatMonitor(this.meetManager);
    this.audioPlayer = new AudioPlayer();
    this.queueManager = new QueueManager();
    this.youtubeService = new YouTubeService();
    this.downloader = new Downloader();

    this.deps = {
      audioPlayer: this.audioPlayer,
      queueManager: this.queueManager,
      youtubeService: this.youtubeService,
      downloader: this.downloader,
      meetManager: this.meetManager,
      onExit: () => {
        logger.info('Exit command received');
        this.shutdown();
      },
    };
  }

  async start(meetUrl: string): Promise<void> {
    logger.info(`Starting ${config.botName}`);

    // Initialize YouTube service
    await this.youtubeService.init();

    // Join the meeting
    await this.meetManager.join(meetUrl);

    // Export Google cookies so yt-dlp can access YouTube
    await this.meetManager.exportCookiesForYtDlp();

    // Start chat monitoring
    await this.chatMonitor.start();

    // Wire up chat messages to command parser
    this.chatMonitor.on('message', (msg: ChatMessage) => {
      this.handleChatMessage(msg).catch((err) => {
        logger.error(`Error handling chat message: ${err}`);
      });
    });

    // Wire up audio player — advance queue when a song finishes
    this.audioPlayer.on('finished', () => {
      const next = this.queueManager.advance();
      if (next) {
        playNextInQueue(this.deps).catch((err) => {
          logger.error(`Error playing next song: ${err}`);
        });
      } else {
        logger.info('Queue finished');
      }
    });

    // Handle meeting disconnection
    this.meetManager.on('left', () => {
      logger.info('Left the meeting');
      this.shutdown();
    });

    // Monitor participant count — leave if bot is alone
    this.startParticipantMonitor();

    logger.info(`${config.botName} is running. Listening for commands in chat.`);

    // Announce ready in chat
    await this.meetManager.sendChatMessage('MeetBeats is ready! Type !help for commands.').catch(() => {});

    // Keep the process alive until shutdown
    await new Promise<void>((resolve) => {
      this.shutdownResolve = resolve;
      const onSignal = () => {
        logger.info('Received shutdown signal');
        this.shutdown();
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
    });
  }

  private startParticipantMonitor(): void {
    // Check every 15 seconds if the bot is alone in the meeting
    this.participantCheckInterval = setInterval(async () => {
      try {
        const page = this.meetManager.getPage();
        const count = await page.evaluate(() => {
          // Look for participant count in the toolbar
          const el = document.querySelector('[aria-label*="participant" i]');
          const text = el?.textContent || '';
          const match = text.match(/(\d+)/);
          return match ? parseInt(match[1], 10) : -1;
        });

        if (count === 1) {
          logger.info('Bot is alone in the meeting. Leaving...');
          await this.shutdown();
        } else if (count > 0) {
          logger.debug(`Participants: ${count}`);
        }
      } catch {
        // Page may not be available during shutdown
      }
    }, 15000);
  }

  private async handleChatMessage(msg: ChatMessage): Promise<void> {
    const cmd = parseCommand(msg.sender, msg.text);
    if (!cmd) return;
    await handleCommand(cmd, this.deps);
  }

  async shutdown(): Promise<void> {
    // Guard against re-entrant calls (leave emits 'left' which triggers shutdown again)
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    logger.info('Shutting down...');

    // Safety net: force exit if graceful shutdown stalls (e.g. browser cleanup hangs)
    const forceExit = setTimeout(() => {
      logger.error('Shutdown timed out after 8s — forcing exit');
      process.exit(1);
    }, 8000);
    forceExit.unref();

    if (this.participantCheckInterval) {
      clearInterval(this.participantCheckInterval);
      this.participantCheckInterval = null;
    }

    await this.audioPlayer.stop();
    this.chatMonitor.stop();
    await this.meetManager.leave();

    logger.info('Shutdown complete');

    if (this.shutdownResolve) {
      this.shutdownResolve();
      this.shutdownResolve = null;
    }

    // Exit the process (ensures Docker container stops)
    process.exit(0);
  }
}
