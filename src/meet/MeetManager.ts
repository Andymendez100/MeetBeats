import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { EventEmitter } from 'events';
import fs from 'fs';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { selectors } from './selectors.js';

const COOKIES_FILE = '/tmp/meetbeats/cookies.txt';

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
      if (text.includes('[MeetBeats]')) {
        // MeetBeats logs always show at info level for visibility
        const level = msg.type() === 'error' ? 'error' : 'info';
        logger[level](`[Browser] ${text}`);
      } else if (text.includes('getUserMedia') || text.includes('audio')) {
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

  /**
   * Export browser cookies in Netscape format for yt-dlp.
   * Google session cookies from the Playwright browser let yt-dlp
   * access YouTube without being blocked as a bot.
   */
  async exportCookiesForYtDlp(): Promise<void> {
    if (!this.context) return;
    try {
      const cookies = await this.context.cookies([
        'https://www.youtube.com',
        'https://youtube.com',
        'https://accounts.google.com',
        'https://www.google.com',
      ]);

      const lines = ['# Netscape HTTP Cookie File', '# Exported by MeetBeats'];
      for (const c of cookies) {
        const domain = c.domain.startsWith('.') ? c.domain : `.${c.domain}`;
        const flag = domain.startsWith('.') ? 'TRUE' : 'FALSE';
        const secure = c.secure ? 'TRUE' : 'FALSE';
        const expiry = c.expires > 0 ? Math.floor(c.expires) : '0';
        lines.push(`${domain}\t${flag}\t${c.path}\t${secure}\t${expiry}\t${c.name}\t${c.value}`);
      }

      fs.writeFileSync(COOKIES_FILE, lines.join('\n') + '\n');
      logger.info(`Exported ${cookies.length} cookies for yt-dlp`);
    } catch (err) {
      logger.warn(`Could not export cookies: ${err}`);
    }
  }

  private async dismissModals(): Promise<void> {
    if (!this.page) return;
    // Only dismiss actual modal/banner buttons — NOT buttons inside the chat panel.
    // Use :not() to exclude buttons within the chat panel or message areas.
    const dismissSelectors = [
      'button:has-text("Got it"):not([aria-label*="chat" i])',
      'button:has-text("Dismiss"):not([aria-label*="chat" i])',
    ];

    for (const sel of dismissSelectors) {
      try {
        const btn = this.page.locator(sel).first();
        if (await btn.isVisible({ timeout: 500 })) {
          await btn.click({ timeout: 1000 });
          logger.info(`Dismissed modal via: ${sel}`);
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

      // Explicitly click Audio tab in case settings remembers a different tab
      const audioTab = this.page.locator('[role="tab"]:has-text("Audio")').first();
      try {
        await audioTab.waitFor({ state: 'visible', timeout: 3000 });
        await audioTab.click();
        await this.page.waitForTimeout(500);
      } catch {
        logger.warn('Audio tab not found — may already be selected');
      }

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
    try {
      // waitFor actually waits for the element to appear and be visible,
      // unlike isVisible() which is a snapshot check
      await toggle.waitFor({ state: 'visible', timeout: 5000 });
      await toggle.scrollIntoViewIfNeeded();
      const checked = await toggle.getAttribute('aria-checked');
      const isOn = checked === 'true';
      if (isOn !== targetState) {
        await toggle.click({ force: true });
        logger.info(`${label}: ${targetState ? 'enabled' : 'disabled'}`);
      } else {
        logger.info(`${label}: already ${targetState ? 'on' : 'off'}`);
      }
    } catch {
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

    // Find the chat input using fallback selectors
    for (const inputSel of selectors.chatInputCandidates) {
      try {
        const chatInput = this.page.locator(inputSel).first();
        if (await chatInput.isVisible({ timeout: 1000 })) {
          await chatInput.fill(message);
          await chatInput.press('Enter');
          return;
        }
      } catch {
        // Try next
      }
    }

    logger.warn('Could not find chat input to send message');
  }

  async openChatPanel(): Promise<void> {
    if (!this.page) return;

    // Check if chat input is already visible via any candidate selector
    for (const inputSel of selectors.chatInputCandidates) {
      try {
        const isOpen = await this.page.locator(inputSel).first().isVisible().catch(() => false);
        if (isOpen) {
          logger.debug('Chat panel already open');
          return;
        }
      } catch {
        // Try next
      }
    }

    // Try each chat button candidate
    for (const btnSel of selectors.chatButtonCandidates) {
      try {
        const btn = this.page.locator(btnSel).first();
        if (await btn.isVisible({ timeout: 1000 })) {
          await btn.click({ timeout: 3000 });
          logger.info(`Opened chat via: ${btnSel}`);

          // Wait for any chat input candidate to appear
          for (const inputSel of selectors.chatInputCandidates) {
            try {
              await this.page.locator(inputSel).waitFor({ state: 'visible', timeout: 3000 });
              logger.info(`Chat input found: ${inputSel}`);
              return;
            } catch {
              // Try next input selector
            }
          }
          // Button clicked but no input found — still might have opened
          logger.warn('Chat button clicked but input not found with any selector');
          return;
        }
      } catch {
        // Try next button selector
      }
    }

    logger.warn('Could not open chat panel — no chat button matched');
  }

  async leave(): Promise<void> {
    logger.info('Leaving meeting');

    if (this.modalDismisserInterval) {
      clearInterval(this.modalDismisserInterval);
      this.modalDismisserInterval = null;
    }

    try {
      if (this.page && this.browser?.isConnected()) {
        // Navigate away from Meet — this instantly leaves the call.
        // Faster and more reliable than clicking the leave button,
        // which can be blocked by modals or overlays.
        await this.page.goto('about:blank', { timeout: 5000 });
      }
      logger.info('Left the meeting');
    } catch (err) {
      // Browser may already be dead (e.g. Ctrl+C killed Chromium via process group).
      // That's fine — severed WebRTC connection means we've left the call.
      logger.info('Left the meeting (browser already closed)');
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
