import { Song, LoopMode } from './types.js';
import { logger } from '../utils/logger.js';

export class QueueManager {
  private songs: Song[] = [];
  private currentIndex = -1;
  private loopMode: LoopMode = 'off';
  private autoplay = true;
  private lastPlayed: Song | null = null;

  add(song: Song): number {
    this.songs.push(song);
    const position = this.songs.length;
    logger.debug(`Queued #${position}: ${song.title}`);

    // If nothing is playing, set current to this song
    if (this.currentIndex === -1) {
      this.currentIndex = 0;
    }

    return position;
  }

  current(): Song | null {
    if (this.currentIndex < 0 || this.currentIndex >= this.songs.length) {
      return null;
    }
    return this.songs[this.currentIndex];
  }

  advance(): Song | null {
    if (this.songs.length === 0) return null;

    switch (this.loopMode) {
      case 'song':
        // Replay current song
        return this.current();

      case 'queue':
        this.currentIndex = (this.currentIndex + 1) % this.songs.length;
        return this.current();

      case 'off':
      default:
        this.lastPlayed = this.current();
        this.currentIndex++;
        if (this.currentIndex >= this.songs.length) {
          // Queue exhausted
          this.currentIndex = -1;
          this.songs = [];
          return null;
        }
        return this.current();
    }
  }

  getQueue(): Song[] {
    return [...this.songs];
  }

  getCurrentIndex(): number {
    return this.currentIndex;
  }

  remove(index: number): Song | null {
    if (index < 0 || index >= this.songs.length) return null;

    const [removed] = this.songs.splice(index, 1);

    // Adjust current index
    if (index < this.currentIndex) {
      this.currentIndex--;
    } else if (index === this.currentIndex) {
      // Removed current song — keep index, it now points to the next
      if (this.currentIndex >= this.songs.length) {
        this.currentIndex = this.songs.length > 0 ? 0 : -1;
      }
    }

    logger.debug(`Removed from queue: ${removed.title}`);
    return removed;
  }

  shuffle(): void {
    if (this.songs.length <= 1) return;

    const currentSong = this.current();

    // Fisher-Yates shuffle on remaining songs (after current)
    const remaining = this.songs.slice(this.currentIndex + 1);
    for (let i = remaining.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
    }

    // Rebuild queue: songs up to current + current + shuffled remaining
    this.songs = [
      ...this.songs.slice(0, this.currentIndex + 1),
      ...remaining,
    ];

    logger.debug('Queue shuffled');
  }

  toggleLoop(): LoopMode {
    const modes: LoopMode[] = ['off', 'song', 'queue'];
    const currentModeIndex = modes.indexOf(this.loopMode);
    this.loopMode = modes[(currentModeIndex + 1) % modes.length];
    logger.debug(`Loop mode: ${this.loopMode}`);
    return this.loopMode;
  }

  getLoopMode(): LoopMode {
    return this.loopMode;
  }

  clear(): void {
    this.songs = [];
    this.currentIndex = -1;
    logger.debug('Queue cleared');
  }

  toggleAutoplay(): boolean {
    this.autoplay = !this.autoplay;
    logger.debug(`Autoplay: ${this.autoplay ? 'on' : 'off'}`);
    return this.autoplay;
  }

  isAutoplay(): boolean {
    return this.autoplay;
  }

  getLastPlayed(): Song | null {
    return this.lastPlayed;
  }

  get length(): number {
    return this.songs.length;
  }
}
