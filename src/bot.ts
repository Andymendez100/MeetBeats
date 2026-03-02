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
    };
  }

  async start(meetUrl: string): Promise<void> {
    logger.info(`Starting ${config.botName}`);

    // Initialize YouTube service
    await this.youtubeService.init();

    // Join the meeting
    await this.meetManager.join(meetUrl);

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

    logger.info(`${config.botName} is running. Listening for commands in chat.`);

    // Keep the process alive
    await new Promise<void>((resolve) => {
      const onSignal = () => {
        logger.info('Received shutdown signal');
        this.shutdown().then(resolve);
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
    });
  }

  private async handleChatMessage(msg: ChatMessage): Promise<void> {
    const cmd = parseCommand(msg.sender, msg.text);
    if (!cmd) return;
    await handleCommand(cmd, this.deps);
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down...');
    this.audioPlayer.stop();
    this.chatMonitor.stop();
    await this.meetManager.leave();
    logger.info('Shutdown complete');
  }
}
