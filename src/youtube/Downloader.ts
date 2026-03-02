import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { baseYtDlpArgs } from './ytdlp.js';

export class Downloader {
  private cacheDir: string;

  constructor() {
    this.cacheDir = config.cacheDir;
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  async download(url: string): Promise<string> {
    const videoId = this.extractId(url);
    // yt-dlp adds the extension itself, so use a template
    const outputTemplate = path.join(this.cacheDir, videoId);
    const expectedPath = `${outputTemplate}.opus`;
    const altPath = `${outputTemplate}.webm`;
    const altPath2 = `${outputTemplate}.m4a`;

    // Return cached file if it exists
    for (const p of [expectedPath, altPath, altPath2]) {
      if (fs.existsSync(p)) {
        logger.debug(`Cache hit: ${p}`);
        return p;
      }
    }

    logger.info(`Downloading: ${url}`);
    await this.runYtDlp(url, outputTemplate);
    await this.cleanCache();

    // Find whichever file yt-dlp created
    for (const p of [expectedPath, altPath, altPath2]) {
      if (fs.existsSync(p)) {
        logger.info(`Downloaded: ${p}`);
        return p;
      }
    }

    // Check for any file matching the video ID
    const files = fs.readdirSync(this.cacheDir).filter(f => f.startsWith(videoId));
    if (files.length > 0) {
      const found = path.join(this.cacheDir, files[0]);
      logger.info(`Downloaded: ${found}`);
      return found;
    }

    throw new Error(`Download completed but output file not found for ${videoId}`);
  }

  private runYtDlp(url: string, outputTemplate: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        ...baseYtDlpArgs(),
        '-f', 'bestaudio/best',
        '-x',
        '--audio-format', 'opus',
        '-o', `${outputTemplate}.%(ext)s`,
        '--no-playlist',
        '--no-warnings',
        url,
      ];

      const proc = spawn('yt-dlp', args);

      let stderr = '';
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`yt-dlp exited with code ${code}: ${stderr}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn yt-dlp. Install it: brew install yt-dlp\n${err.message}`));
      });
    });
  }

  private async cleanCache(): Promise<void> {
    try {
      const files = fs.readdirSync(this.cacheDir)
        .map(f => {
          const fullPath = path.join(this.cacheDir, f);
          const stat = fs.statSync(fullPath);
          return { path: fullPath, size: stat.size, mtime: stat.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);

      const maxBytes = config.maxCacheSizeMb * 1024 * 1024;
      let totalSize = 0;

      for (const file of files) {
        totalSize += file.size;
        if (totalSize > maxBytes) {
          fs.unlinkSync(file.path);
          logger.debug(`Cache cleanup: removed ${file.path}`);
        }
      }
    } catch (err) {
      logger.warn(`Cache cleanup failed: ${err}`);
    }
  }

  private extractId(url: string): string {
    const match = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : url.replace(/[^a-zA-Z0-9]/g, '_');
  }
}
