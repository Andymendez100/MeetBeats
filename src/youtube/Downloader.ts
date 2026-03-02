import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

export class Downloader {
  private cacheDir: string;

  constructor() {
    this.cacheDir = config.cacheDir;
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  async download(url: string): Promise<string> {
    const videoId = this.extractId(url);
    const outputPath = path.join(this.cacheDir, `${videoId}.wav`);

    // Return cached file if it exists
    if (fs.existsSync(outputPath)) {
      logger.debug(`Cache hit: ${outputPath}`);
      return outputPath;
    }

    logger.info(`Downloading: ${url}`);

    await this.runYtDlp(url, outputPath);
    await this.cleanCache();

    return outputPath;
  }

  private runYtDlp(url: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        '-x',                          // Extract audio
        '--audio-format', 'wav',       // Output as WAV
        '--audio-quality', '0',        // Best quality
        '-o', outputPath,              // Output path
        '--no-playlist',               // Don't download playlists
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
          logger.info(`Downloaded: ${outputPath}`);
          resolve();
        } else {
          reject(new Error(`yt-dlp exited with code ${code}: ${stderr}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn yt-dlp: ${err.message}`));
      });
    });
  }

  private async cleanCache(): Promise<void> {
    try {
      const files = fs.readdirSync(this.cacheDir)
        .filter(f => f.endsWith('.wav'))
        .map(f => {
          const fullPath = path.join(this.cacheDir, f);
          const stat = fs.statSync(fullPath);
          return { path: fullPath, size: stat.size, mtime: stat.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime); // newest first

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
