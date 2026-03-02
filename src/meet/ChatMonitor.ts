import { Page } from 'playwright';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import { MeetManager } from './MeetManager.js';

export interface ChatMessage {
  sender: string;
  text: string;
  timestamp: Date;
}

export class ChatMonitor extends EventEmitter {
  private running = false;

  constructor(private meetManager: MeetManager) {
    super();
  }

  async start(): Promise<void> {
    const page = this.meetManager.getPage();

    // Ensure chat panel is open
    await this.meetManager.openChatPanel();

    // Wait for the chat message list container to appear
    await page.waitForSelector('div[jsname="xySENc"]', { state: 'attached', timeout: 10000 }).catch(() => {
      logger.warn('Chat message list container not found, will retry in evaluate');
    });

    // Expose a function that the browser context can call to send messages to Node.js
    await page.exposeFunction('__meetbeats_onChatMessage', (sender: string, text: string) => {
      const message: ChatMessage = {
        sender,
        text,
        timestamp: new Date(),
      };
      logger.info(`Chat message from ${sender}: ${text}`);
      this.emit('message', message);
    });

    // Inject MutationObserver to watch for new chat messages
    await page.evaluate(() => {
      const findChatContainer = (): Element | null => {
        // Primary: the message list container
        const primary = document.querySelector('div[jsname="xySENc"]');
        if (primary) return primary;

        // Fallback: the chat panel itself
        const panel = document.querySelector('#ME4pNd');
        if (panel) return panel;

        return null;
      };

      let retryCount = 0;
      const MAX_RETRIES = 30;

      const setupObserver = () => {
        const container = findChatContainer();
        if (!container) {
          retryCount++;
          if (retryCount <= MAX_RETRIES) {
            setTimeout(setupObserver, 1000);
          } else {
            console.error('[MeetBeats] Could not find chat container after retries');
          }
          return;
        }

        console.log('[MeetBeats] Chat container found, attaching observer');

        // Track seen message IDs to avoid duplicates
        const seenMessageIds = new Set<string>();

        const processMessage = (node: HTMLElement) => {
          // Skip the bot's own messages (they have class chmVPb)
          if (node.querySelector('.chmVPb')) return;

          // Get message ID for deduplication
          const msgEl = node.querySelector('[data-message-id]');
          const msgId = msgEl?.getAttribute('data-message-id') || '';
          if (msgId && seenMessageIds.has(msgId)) return;
          if (msgId) seenMessageIds.add(msgId);

          // Extract sender name
          const senderEl = node.querySelector('div.poVWob');
          const sender = senderEl?.textContent?.trim() || 'Unknown';

          // Extract message text
          const textEl = node.querySelector('div[jsname="dTKtvb"]');
          const text = textEl?.textContent?.trim() || '';

          if (!text) return;

          // Prevent memory leak
          if (seenMessageIds.size > 500) {
            const entries = Array.from(seenMessageIds);
            for (let i = 0; i < 250; i++) {
              seenMessageIds.delete(entries[i]);
            }
          }

          (window as any).__meetbeats_onChatMessage(sender, text);
        };

        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
              if (!(node instanceof HTMLElement)) continue;

              // Check if this is a message item (jsname="Ypafjf")
              if (node.getAttribute('jsname') === 'Ypafjf') {
                processMessage(node);
              } else {
                // Could be a wrapper — check children
                const msgItems = node.querySelectorAll('div[jsname="Ypafjf"]');
                msgItems.forEach((item) => processMessage(item as HTMLElement));
              }
            }
          }
        });

        observer.observe(container, { childList: true, subtree: true });
      };

      setupObserver();
    });

    this.running = true;
    logger.info('Chat monitor started');
  }

  isRunning(): boolean {
    return this.running;
  }

  stop(): void {
    this.running = false;
    logger.info('Chat monitor stopped');
  }
}
