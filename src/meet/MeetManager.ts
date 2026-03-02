import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { EventEmitter } from 'events';
import fs from 'fs';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { selectors } from './selectors.js';

export class MeetManager extends EventEmitter {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  getPage(): Page {
    if (!this.page) throw new Error('Browser page not initialized. Call join() first.');
    return this.page;
  }

  async join(meetUrl: string): Promise<void> {
    logger.info(`Joining meeting: ${meetUrl}`);

    this.browser = await chromium.launch({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-translate',
      ],
    });

    // Load auth state if available
    const contextOptions: Record<string, unknown> = {
      permissions: ['microphone', 'camera'],
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    };

    if (fs.existsSync(config.authStatePath)) {
      logger.info('Loading saved auth state');
      contextOptions.storageState = config.authStatePath;
    } else {
      logger.warn('No auth state found. Run "npm run setup-auth" first.');
    }

    this.context = await this.browser.newContext(contextOptions);
    this.page = await this.context.newPage();

    // Navigate to meeting
    await this.page.goto(meetUrl, { waitUntil: 'networkidle', timeout: 30000 });

    // Dismiss any modals
    await this.dismissModals();

    // Disable camera and mic on pre-join screen
    await this.disableCameraAndMic();

    // Click join button
    await this.clickJoin();

    // Wait to be in the call
    await this.waitForCallJoined();

    logger.info('Successfully joined meeting');
    this.emit('joined');
  }

  private async dismissModals(): Promise<void> {
    try {
      const dismiss = this.page!.locator(selectors.dismissButton).first();
      await dismiss.click({ timeout: 3000 });
      logger.info('Dismissed modal');
    } catch {
      // No modal to dismiss
    }
  }

  private async disableCameraAndMic(): Promise<void> {
    try {
      // Try to turn off camera
      const cameraBtn = this.page!.locator(selectors.cameraButton).first();
      const cameraLabel = await cameraBtn.getAttribute('aria-label', { timeout: 3000 });
      if (cameraLabel && !cameraLabel.toLowerCase().includes('turn on')) {
        await cameraBtn.click();
        logger.info('Camera turned off');
      }
    } catch {
      logger.debug('Could not toggle camera (may already be off)');
    }

    try {
      // Try to turn off mic
      const micBtn = this.page!.locator(selectors.micButton).first();
      const micLabel = await micBtn.getAttribute('aria-label', { timeout: 3000 });
      if (micLabel && !micLabel.toLowerCase().includes('turn on')) {
        await micBtn.click();
        logger.info('Microphone turned off');
      }
    } catch {
      logger.debug('Could not toggle mic (may already be off)');
    }
  }

  private async clickJoin(): Promise<void> {
    const joinBtn = this.page!.locator(selectors.joinButton).first();
    await joinBtn.waitFor({ state: 'visible', timeout: 15000 });
    await joinBtn.click();
    logger.info('Clicked join button');
  }

  private async waitForCallJoined(): Promise<void> {
    // Wait for the leave button to appear — indicates we're in the call
    await this.page!.locator(selectors.leaveButton).waitFor({
      state: 'visible',
      timeout: 30000,
    });
  }

  async sendChatMessage(message: string): Promise<void> {
    if (!this.page) throw new Error('Not in a meeting');

    // Ensure chat panel is open
    await this.openChatPanel();

    // Type and send message
    const chatInput = this.page.locator(selectors.chatInput).first();
    await chatInput.waitFor({ state: 'visible', timeout: 5000 });
    await chatInput.fill(message);

    const sendBtn = this.page.locator(selectors.chatSendButton).first();
    await sendBtn.click();
  }

  async openChatPanel(): Promise<void> {
    if (!this.page) return;

    try {
      // Check if chat panel is already open
      const panel = this.page.locator(selectors.chatPanel);
      if (await panel.isVisible()) return;
    } catch {
      // Panel not visible, open it
    }

    try {
      const chatBtn = this.page.locator(selectors.chatButton).first();
      await chatBtn.click({ timeout: 5000 });
      // Wait for chat panel to open
      await this.page.locator(selectors.chatPanel).waitFor({ state: 'visible', timeout: 5000 });
    } catch {
      logger.warn('Could not open chat panel');
    }
  }

  async leave(): Promise<void> {
    logger.info('Leaving meeting');
    try {
      if (this.page) {
        const leaveBtn = this.page.locator(selectors.leaveButton).first();
        await leaveBtn.click({ timeout: 5000 });
      }
    } catch {
      logger.warn('Could not click leave button');
    }

    await this.cleanup();
    this.emit('left');
  }

  async cleanup(): Promise<void> {
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
    this.page = null;
  }
}
