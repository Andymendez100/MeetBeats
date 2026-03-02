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
  private modalDismisserInterval: ReturnType<typeof setInterval> | null = null;

  getPage(): Page {
    if (!this.page) throw new Error('Browser page not initialized. Call join() first.');
    return this.page;
  }

  async join(meetUrl: string): Promise<void> {
    logger.info(`Joining meeting: ${meetUrl}`);

    this.browser = await chromium.launch({
      headless: false,
      // Don't let Playwright auto-close browser on signals — we handle shutdown ourselves
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--use-fake-ui-for-media-stream',       // Auto-accept mic/camera permission
        '--disable-gpu',
        '--disable-extensions',
        '--disable-translate',
        '--autoplay-policy=no-user-gesture-required',
        // Disable Chrome's WebRTC audio processing that filters music as "noise"
        '--disable-features=AudioServiceAudioProcessing,WebRtcApmInAudioService',
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

    // Forward browser console logs to Node.js for diagnostics
    this.page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[MeetBeats]') || text.includes('getUserMedia') || text.includes('audio')) {
        logger.debug(`[Browser] ${text}`);
      }
    });

    // Override getUserMedia to disable audio processing (echo cancellation,
    // noise suppression, auto gain control) which can filter out music.
    // Chrome uses PulseAudio meetbeats_mic as its real microphone.
    await this.page.addInitScript(() => {
      const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = function (constraints) {
        // Disable all audio processing — both standard and Chrome-specific (goog*) constraints
        const noProcessing: Record<string, unknown> = {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          // Chrome-specific: disable at the WebRTC APM level
          googEchoCancellation: false,
          googAutoGainControl: false,
          googNoiseSuppression: false,
          googHighpassFilter: false,
          googAudioMirroring: false,
        };
        if (constraints && typeof constraints.audio === 'object') {
          Object.assign(constraints.audio, noProcessing);
        } else if (constraints && constraints.audio === true) {
          constraints.audio = noProcessing;
        }
        console.log('[MeetBeats] getUserMedia called with:', JSON.stringify(constraints));
        return origGetUserMedia(constraints);
      };
      console.log('[MeetBeats] getUserMedia override installed (all audio processing disabled)');
    });

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

    // Dismiss any post-join modals
    await this.dismissModals();

    // Start a background interval to keep dismissing modals
    this.startModalDismisser();

    // Verify mic is ON after joining (critical for audio pipeline)
    await this.verifyMicOn();

    // Disable Google Meet's audio filters (Studio sound, Adaptive audio)
    await this.disableAudioFilters();

    logger.info('Successfully joined meeting');
    this.emit('joined');
  }

  private async dismissModals(): Promise<void> {
    if (!this.page) return;
    // Try clicking any "Got it" / "Dismiss" / "OK" buttons that are modal dismissals
    const dismissSelectors = [
      'button:has-text("Got it")',
      'button:has-text("Dismiss")',
      'button:has-text("OK")',
      'button:has-text("Close")',
    ];

    for (const sel of dismissSelectors) {
      try {
        const btn = this.page.locator(sel).first();
        if (await btn.isVisible({ timeout: 500 })) {
          await btn.click({ timeout: 1000 });
          logger.info(`Dismissed modal via: ${sel}`);
          // Wait briefly and try again in case there are stacked modals
          await this.page.waitForTimeout(500);
        }
      } catch {
        // No modal with this selector
      }
    }
  }

  private startModalDismisser(): void {
    // Check for and dismiss modals every 3 seconds
    this.modalDismisserInterval = setInterval(() => {
      this.dismissModals().catch(() => {});
    }, 3000);
  }

  private async disableCameraAndMic(): Promise<void> {
    try {
      // Turn off camera — we don't need video
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
      // Ensure mic is ON — this is how audio flows from PulseAudio to Meet
      const micBtn = this.page!.locator(selectors.micButton).first();
      const micLabel = await micBtn.getAttribute('aria-label', { timeout: 3000 });
      if (micLabel && micLabel.toLowerCase().includes('turn on')) {
        await micBtn.click();
        logger.info('Microphone turned on');
      }
    } catch {
      logger.debug('Could not toggle mic (may already be on)');
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

  async verifyMicOn(): Promise<void> {
    if (!this.page) return;
    try {
      // Wait a moment for Google Meet to settle after joining
      await this.page.waitForTimeout(2000);

      const micBtn = this.page.locator(selectors.micButton).first();
      const micLabel = await micBtn.getAttribute('aria-label', { timeout: 3000 });
      logger.info(`Mic status after join: "${micLabel}"`);

      // If label says "Turn on" the mic is currently OFF — turn it on
      if (micLabel && micLabel.toLowerCase().includes('turn on')) {
        await micBtn.click();
        logger.info('Mic was OFF after joining — turned it ON');
        await this.page.waitForTimeout(1000);
      } else {
        logger.info('Mic is ON — audio pipeline should be active');
      }
    } catch (err) {
      logger.warn(`Could not verify mic status: ${err}`);
    }
  }

  async disableAudioFilters(): Promise<void> {
    if (!this.page) return;
    try {
      logger.info('Disabling Meet audio filters...');

      // 1. Click three-dots "More options" button
      const moreBtn = this.page.locator(selectors.moreOptionsButton).first();
      await moreBtn.waitFor({ state: 'visible', timeout: 5000 });
      await moreBtn.click();
      await this.page.waitForTimeout(800);

      // 2. Click "Settings" menu item
      const settingsItem = this.page.locator('[role="menuitem"]:has-text("Settings")').first();
      await settingsItem.waitFor({ state: 'visible', timeout: 3000 });
      await settingsItem.click();
      await this.page.waitForTimeout(1000);

      // Settings opens on Audio tab by default.
      // Toggles are: button[role="switch"][aria-label="X"][aria-checked="true|false"]

      // 3. Disable "Studio sound" — "Filters out sound from your mic that isn't speech"
      await this.toggleSwitch('Studio sound', false);

      // 4. Disable "Adaptive audio" — merges nearby devices, can interfere
      await this.toggleSwitch('Adaptive audio', false);

      // 5. Close settings with Escape
      await this.page.waitForTimeout(300);
      await this.page.keyboard.press('Escape');
      await this.page.waitForTimeout(500);

      logger.info('Audio filters disabled, settings closed');
    } catch (err) {
      logger.warn(`Could not disable audio filters: ${err}`);
      try { await this.page!.keyboard.press('Escape'); } catch {}
      try { await this.page!.keyboard.press('Escape'); } catch {}
    }
  }

  private async toggleSwitch(label: string, targetState: boolean): Promise<void> {
    if (!this.page) return;
    const toggle = this.page.locator(`button[role="switch"][aria-label="${label}"]`).first();
    if (await toggle.isVisible({ timeout: 3000 })) {
      const checked = await toggle.getAttribute('aria-checked');
      const isOn = checked === 'true';
      if (isOn !== targetState) {
        await toggle.click({ force: true });
        logger.info(`${label}: ${targetState ? 'enabled' : 'disabled'}`);
      } else {
        logger.info(`${label}: already ${targetState ? 'on' : 'off'}`);
      }
    } else {
      logger.warn(`${label} toggle not found`);
    }
    await this.page.waitForTimeout(300);
  }

  async sendChatMessage(message: string): Promise<void> {
    if (!this.page) throw new Error('Not in a meeting');

    // Dismiss any blocking modals first
    await this.dismissModals();

    // Ensure chat panel is open
    await this.openChatPanel();

    // Type and send message
    const chatInput = this.page.locator(selectors.chatInput).first();
    await chatInput.waitFor({ state: 'visible', timeout: 5000 });
    await chatInput.fill(message);
    await chatInput.press('Enter');
  }

  async openChatPanel(): Promise<void> {
    if (!this.page) return;

    try {
      // Check if chat input is already visible (panel is open)
      const chatInput = this.page.locator(selectors.chatInput).first();
      const isOpen = await chatInput.isVisible().catch(() => false);
      if (isOpen) return;
    } catch {
      // Not open
    }

    try {
      const chatBtn = this.page.locator(selectors.chatButton).first();
      await chatBtn.click({ timeout: 5000 });
      // Wait for chat input to appear (confirms panel is open)
      await this.page.locator(selectors.chatInput).waitFor({ state: 'visible', timeout: 5000 });
    } catch {
      logger.warn('Could not open chat panel');
    }
  }

  async leave(): Promise<void> {
    logger.info('Leaving meeting');

    if (this.modalDismisserInterval) {
      clearInterval(this.modalDismisserInterval);
      this.modalDismisserInterval = null;
    }

    try {
      if (this.page) {
        // Dismiss any modals that might be blocking the leave button
        await this.dismissModals();

        const leaveBtn = this.page.locator(selectors.leaveButton).first();
        if (await leaveBtn.isVisible({ timeout: 2000 })) {
          await leaveBtn.click({ timeout: 5000 });
          logger.info('Clicked leave button');
          // Wait for the leave action to take effect before closing browser
          await this.page.waitForTimeout(2000);
        } else {
          logger.warn('Leave button not visible');
        }
      }
    } catch (err) {
      logger.warn(`Could not click leave button: ${err}`);
    }

    await this.cleanup();
    this.emit('left');
  }

  async cleanup(): Promise<void> {
    if (this.modalDismisserInterval) {
      clearInterval(this.modalDismisserInterval);
      this.modalDismisserInterval = null;
    }
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
