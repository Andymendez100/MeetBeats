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

    // Expose a function that the browser context can call to send messages to Node.js
    await page.exposeFunction('__meetbeats_onChatMessage', (sender: string, text: string) => {
      const message: ChatMessage = {
        sender,
        text,
        timestamp: new Date(),
      };
      logger.debug(`Chat message from ${sender}: ${text}`);
      this.emit('message', message);
    });

    // Inject MutationObserver to watch for new chat messages
    await page.evaluate(() => {
      // Find the chat message container
      const findChatContainer = (): Element | null => {
        // Try multiple selectors for the chat message list
        const candidates = [
          document.querySelector('[aria-label="Chat with everyone"]'),
          document.querySelector('[data-is-chat-history]'),
          // Fallback: find container that holds chat messages
          ...Array.from(document.querySelectorAll('div[role="list"]')),
        ];

        for (const el of candidates) {
          if (el) return el;
        }
        return null;
      };

      const setupObserver = () => {
        const container = findChatContainer();
        if (!container) {
          // Retry after a short delay
          setTimeout(setupObserver, 1000);
          return;
        }

        // Track messages we've already seen to avoid duplicates
        const seenMessages = new Set<string>();

        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
              if (!(node instanceof HTMLElement)) continue;

              // Extract sender and message text from the new chat node
              const senderEl =
                node.querySelector('[data-sender-name]') ||
                node.querySelector('span[class]');
              const textEl =
                node.querySelector('[data-message-text]') ||
                node.querySelector('div[class] > span');

              if (!senderEl || !textEl) continue;

              const sender = senderEl.textContent?.trim() || 'Unknown';
              const text = textEl.textContent?.trim() || '';

              if (!text) continue;

              // Deduplicate
              const key = `${sender}:${text}:${Date.now() - (Date.now() % 2000)}`;
              if (seenMessages.has(key)) continue;
              seenMessages.add(key);

              // Prevent memory leak — keep set bounded
              if (seenMessages.size > 500) {
                const entries = Array.from(seenMessages);
                for (let i = 0; i < 250; i++) {
                  seenMessages.delete(entries[i]);
                }
              }

              // Send to Node.js
              (window as any).__meetbeats_onChatMessage(sender, text);
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
