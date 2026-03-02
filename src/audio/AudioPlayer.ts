import { EventEmitter } from 'events';
import { ChildProcess, spawn } from 'child_process';
import { logger } from '../utils/logger.js';
import { config } from '../utils/config.js';

/**
 * Plays audio into Google Meet via PulseAudio.
 *
 * Audio pipeline:
 *   ffmpeg → PulseAudio meetbeats_sink → monitor → meetbeats_mic → Chrome mic → WebRTC
 *
 * Chrome uses meetbeats_mic (PulseAudio default source) as its real microphone.
 * ffmpeg outputs to meetbeats_sink via PULSE_SINK env var.
 * The monitor of meetbeats_sink feeds into meetbeats_mic (remap-source).
 * Chrome captures from meetbeats_mic and sends via WebRTC to other participants.
 */
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
    await this.stop();

    this.playing = true;
    this.paused = false;

    logger.info(`Playing: ${filePath} at volume ${this.volume}%`);

    // ffmpeg always outputs at full 3x boost (compensates for WebRTC chain loss).
    // Actual volume is controlled in real-time via PulseAudio sink volume.
    this.process = spawn('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-i', filePath,
      '-af', 'volume=3.0',
      '-f', 'pulse',
      '-ac', '2',
      '-ar', '48000',
      'meetbeats_music',
    ], {
      env: { ...process.env, PULSE_SINK: 'meetbeats_sink' },
    });

    // Apply current volume to PulseAudio sink
    this.applyVolume();

    let stderr = '';
    this.process.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    this.process.on('close', (code) => {
      this.process = null;
      if (this.playing) {
        this.playing = false;
        this.paused = false;
        if (code !== 0 && stderr) {
          logger.error(`ffmpeg playback error: ${stderr}`);
          this.emit('error', new Error(stderr));
        } else {
          logger.debug('Playback finished');
          this.emit('finished');
        }
      }
    });

    this.process.on('error', (err) => {
      this.playing = false;
      this.process = null;
      logger.error(`ffmpeg spawn error: ${err}`);
      this.emit('error', err);
    });
  }

  async stop(): Promise<void> {
    if (!this.process) {
      this.playing = false;
      this.paused = false;
      return;
    }

    const proc = this.process;
    // If paused (SIGSTOP'd), resume first so it can receive SIGTERM
    if (this.paused) {
      proc.kill('SIGCONT');
    }
    this.playing = false;
    this.paused = false;
    this.process = null;

    // Wait for the ffmpeg process to actually exit
    await new Promise<void>((resolve) => {
      proc.on('close', resolve);
      proc.kill('SIGTERM');
    });
  }

  async pause(): Promise<void> {
    if (!this.process || !this.playing || this.paused) return;
    this.process.kill('SIGSTOP');
    this.paused = true;
    logger.info('Playback paused');
  }

  async resume(): Promise<void> {
    if (!this.process || !this.paused) return;
    this.process.kill('SIGCONT');
    this.paused = false;
    logger.info('Playback resumed');
  }

  setVolume(vol: number): void {
    this.volume = Math.max(0, Math.min(100, vol));
    logger.info(`Volume set to ${this.volume}%`);
    this.applyVolume();
  }

  /** Apply volume to PulseAudio sink in real-time (affects current playback immediately) */
  private applyVolume(): void {
    // Map 0-100 to 0-100% of the PulseAudio sink.
    // ffmpeg outputs at fixed 3x boost, so sink 100% = full volume.
    const pct = `${this.volume}%`;
    spawn('pactl', ['set-sink-volume', 'meetbeats_sink', pct]);
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
