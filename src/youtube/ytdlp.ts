import fs from 'fs';
import { config } from '../utils/config.js';

/** Common yt-dlp args shared by Downloader and YouTubeService */
export function baseYtDlpArgs(): string[] {
  const args: string[] = [];

  if (fs.existsSync(config.cookiesFile)) {
    args.push('--cookies', config.cookiesFile);
  }

  // Node.js runtime + EJS challenge solver for YouTube format signature decryption
  args.push('--js-runtimes', 'node');
  args.push('--remote-components', 'ejs:github');

  return args;
}
