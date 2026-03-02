import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import { config } from '../utils/config.js';

export class AudioPlayer extends EventEmitter {
  private process: ChildProcess | null = null;
  private playing = false;
  private paused = false;
  private volume: number;

  constructor() {
    super();
    this.volume = config.defaultVolume;
  }

  async play(filePath: string): Promise<void> {
    // Stop any currently playing audio
    this.stop();

    const volumeFilter = `volume=${this.volume / 100}`;

    // Use ffplay to play the audio file, piping to PulseAudio's null sink
    this.process = spawn('ffplay', [
      '-nodisp',        // No video display
      '-autoexit',      // Exit when done
      '-af', volumeFilter,
      filePath,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.playing = true;
    this.paused = false;

    this.process.on('close', (code) => {
      const wasPlaying = this.playing;
      this.playing = false;
      this.paused = false;
      this.process = null;

      if (wasPlaying) {
        logger.debug(`Playback finished (code: ${code})`);
        this.emit('finished');
      }
    });

    this.process.on('error', (err) => {
      logger.error(`ffplay error: ${err.message}`);
      this.playing = false;
      this.process = null;
      this.emit('error', err);
    });

    logger.info(`Playing: ${filePath} at volume ${this.volume}%`);
  }

  stop(): void {
    if (this.process) {
      this.playing = false;
      this.paused = false;

      // Resume first if paused (SIGCONT), then kill
      if (this.paused) {
        this.process.kill('SIGCONT');
      }
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }

  pause(): void {
    if (this.process && this.playing && !this.paused) {
      this.process.kill('SIGSTOP');
      this.paused = true;
      logger.info('Playback paused');
    }
  }

  resume(): void {
    if (this.process && this.paused) {
      this.process.kill('SIGCONT');
      this.paused = false;
      logger.info('Playback resumed');
    }
  }

  setVolume(vol: number): void {
    this.volume = Math.max(0, Math.min(100, vol));
    logger.info(`Volume set to ${this.volume}%`);
    // Volume change takes effect on next song (ffplay doesn't support live volume change)
    // For live volume, we'd need to restart ffplay — but that causes a gap
  }

  getVolume(): number {
    return this.volume;
  }

  isPlaying(): boolean {
    return this.playing && !this.paused;
  }

  isPaused(): boolean {
    return this.paused;
  }
}
