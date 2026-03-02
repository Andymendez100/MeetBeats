import { spawn } from 'child_process';
import fs from 'fs';
import { logger } from '../utils/logger.js';
import { Song } from '../audio/types.js';

const COOKIES_FILE = '/tmp/meetbeats/cookies.txt';

interface YtDlpResult {
  id: string;
  title: string;
  duration: number;
  url: string;
  webpage_url: string;
}

/**
 * YouTube search and metadata via yt-dlp.
 * Replaces youtubei.js to avoid parser errors from YouTube API changes.
 */
export class YouTubeService {
  async init(): Promise<void> {
    try {
      await this.runYtDlp(['--version']);
      logger.info('YouTube service initialized (yt-dlp)');
    } catch (err) {
      throw new Error(`yt-dlp not found. Install it: pip install yt-dlp\n${err}`);
    }
  }

  async search(query: string): Promise<Omit<Song, 'requestedBy'> | null> {
    try {
      // --flat-playlist skips full video resolution (no format selection),
      // just returns search result metadata — title, url, duration
      const result = await this.runYtDlp([
        `ytsearch1:${query}`,
        '--dump-json',
        '--flat-playlist',
        '--no-warnings',
      ]);

      const data: YtDlpResult = JSON.parse(result);
      return {
        title: data.title || 'Unknown',
        url: data.webpage_url || data.url || `https://www.youtube.com/watch?v=${data.id}`,
        duration: data.duration || 0,
      };
    } catch (err) {
      logger.error(`YouTube search failed: ${err}`);
      return null;
    }
  }

  async getInfo(url: string): Promise<Omit<Song, 'requestedBy'> | null> {
    try {
      const result = await this.runYtDlp([
        url,
        '--dump-json',
        '--no-warnings',
        '--no-playlist',
        '--skip-download',
        '-f', 'bestaudio/best/worst',
      ]);

      const data: YtDlpResult = JSON.parse(result);
      return {
        title: data.title || 'Unknown',
        url: data.webpage_url || url,
        duration: data.duration || 0,
      };
    } catch (err) {
      logger.error(`Failed to get video info: ${err}`);
      return null;
    }
  }

  async getPlaylist(url: string): Promise<Omit<Song, 'requestedBy'>[]> {
    try {
      const result = await this.runYtDlp([
        url,
        '--dump-json',
        '--no-warnings',
        '--flat-playlist',
        '--skip-download',
      ]);

      const songs: Omit<Song, 'requestedBy'>[] = [];
      for (const line of result.split('\n').filter(Boolean)) {
        const data: YtDlpResult = JSON.parse(line);
        songs.push({
          title: data.title || 'Unknown',
          url: data.webpage_url || data.url || `https://www.youtube.com/watch?v=${data.id}`,
          duration: data.duration || 0,
        });
      }

      logger.info(`Loaded ${songs.length} songs from playlist`);
      return songs;
    } catch (err) {
      logger.error(`Failed to load playlist: ${err}`);
      return [];
    }
  }

  /** Build common yt-dlp args, including cookies if available */
  private cookieArgs(): string[] {
    if (fs.existsSync(COOKIES_FILE)) {
      return ['--cookies', COOKIES_FILE];
    }
    return [];
  }

  private runYtDlp(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const fullArgs = [...this.cookieArgs(), ...args];
      const proc = spawn('yt-dlp', fullArgs);

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`yt-dlp exited with code ${code}: ${stderr}`));
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }
}
