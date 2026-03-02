import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export const config = {
  meetUrl: process.env.MEET_URL || '',
  googleEmail: process.env.GOOGLE_EMAIL || '',
  botName: process.env.BOT_NAME || 'MeetBeats',
  commandPrefix: process.env.COMMAND_PREFIX || '!',
  defaultVolume: parseInt(process.env.DEFAULT_VOLUME || '50', 10),
  cacheDir: process.env.CACHE_DIR || '/tmp/meetbeats',
  maxCacheSizeMb: parseInt(process.env.MAX_CACHE_SIZE_MB || '500', 10),
  authStatePath: path.resolve(process.cwd(), 'auth', 'auth.json'),
};
