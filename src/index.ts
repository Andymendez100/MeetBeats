import { MeetBeatsBot } from './bot.js';
import { config } from './utils/config.js';
import { logger } from './utils/logger.js';

async function main() {
  // Accept meeting URL from CLI arg or env
  const meetUrl = process.argv[2] || config.meetUrl;

  if (!meetUrl) {
    console.error('Usage: meetbeats <google-meet-url>');
    console.error('  or set MEET_URL in .env');
    process.exit(1);
  }

  if (!meetUrl.includes('meet.google.com')) {
    console.error('Error: URL must be a Google Meet link (https://meet.google.com/...)');
    process.exit(1);
  }

  logger.info(`MeetBeats starting — target: ${meetUrl}`);

  const bot = new MeetBeatsBot();

  try {
    await bot.start(meetUrl);
  } catch (err) {
    logger.error(`Fatal error: ${err}`);
    await bot.shutdown();
    process.exit(1);
  }
}

main();
