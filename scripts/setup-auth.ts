import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

const AUTH_DIR = path.resolve(process.cwd(), 'auth');
const AUTH_PATH = path.join(AUTH_DIR, 'auth.json');

async function main() {
  console.log('=== MeetBeats Auth Setup ===');
  console.log('A browser window will open. Please log into your Google account.');
  console.log('After logging in, navigate to https://meet.google.com and press Enter in this terminal.\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://accounts.google.com');

  // Wait for user to complete login
  console.log('Waiting for you to log in...');
  console.log('Press Enter in this terminal when you are logged in and ready.');

  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => resolve());
  });

  // Save auth state
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  await context.storageState({ path: AUTH_PATH });

  console.log(`\nAuth state saved to ${AUTH_PATH}`);
  console.log('You can now run the bot with: npm start');

  await browser.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('Auth setup failed:', err);
  process.exit(1);
});
