import { Page } from 'playwright';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import { MeetManager } from './MeetManager.js';
import { selectors } from './selectors.js';

export interface ChatMessage {
  sender: string;
  text: string;
  timestamp: Date;
}

export class ChatMonitor extends EventEmitter {
  private running = false;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private meetManager: MeetManager) {
    super();
  }

  async start(): Promise<void> {
    const page = this.meetManager.getPage();

    // Ensure chat panel is open
    await this.meetManager.openChatPanel();

    // Wait for any chat container candidate to appear
    let containerFound = false;
    for (const sel of selectors.chatContainerCandidates) {
      try {
        await page.waitForSelector(sel, { state: 'attached', timeout: 3000 });
        logger.info(`Chat container found via: ${sel}`);
        containerFound = true;
        break;
      } catch {
        // Try next
      }
    }
    if (!containerFound) {
      logger.warn('No chat container found with any known selector — observer will retry in-page');
    }

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

    // Pass the candidate selectors into the browser context
    const containerCandidates = selectors.chatContainerCandidates;

    // Inject MutationObserver to watch for new chat messages
    await page.evaluate((candidates: string[]) => {
      const findChatContainer = (): Element | null => {
        for (const sel of candidates) {
          const el = document.querySelector(sel);
          if (el) {
            console.log(`[MeetBeats] Chat container matched: ${sel}`);
            return el;
          }
        }
        return null;
      };

      let retryCount = 0;
      const MAX_RETRIES = 60;

      const setupObserver = () => {
        const container = findChatContainer();
        if (!container) {
          retryCount++;
          if (retryCount <= MAX_RETRIES) {
            if (retryCount % 10 === 0) {
              console.log(`[MeetBeats] Chat container not found yet (retry ${retryCount}/${MAX_RETRIES})`);
            }
            setTimeout(setupObserver, 1000);
          } else {
            console.error('[MeetBeats] Could not find chat container after retries');
          }
          return;
        }

        console.log(`[MeetBeats] Chat observer attached to: ${container.tagName}#${container.id || ''}.${container.className || ''}`);

        // Deduplication: track by message-id AND by text content (with short time window)
        const seenMessageIds = new Set<string>();
        const recentTexts = new Map<string, number>(); // text -> timestamp

        const isDuplicate = (msgId: string, text: string): boolean => {
          // Primary: message-id based dedup
          if (msgId && seenMessageIds.has(msgId)) return true;
          if (msgId) seenMessageIds.add(msgId);

          // Secondary: text-based dedup within 2-second window
          const now = Date.now();
          const lastSeen = recentTexts.get(text);
          if (lastSeen && now - lastSeen < 2000) return true;
          recentTexts.set(text, now);

          // Cleanup old entries
          if (seenMessageIds.size > 500) {
            const entries = Array.from(seenMessageIds);
            for (let i = 0; i < 250; i++) seenMessageIds.delete(entries[i]);
          }
          if (recentTexts.size > 100) {
            const cutoff = now - 5000;
            for (const [k, v] of recentTexts) {
              if (v < cutoff) recentTexts.delete(k);
            }
          }

          return false;
        };

        const processMessage = (node: HTMLElement) => {
          // Skip the bot's own messages.
          // In Google Meet, your own messages don't have a sender name element (div.poVWob).
          // Also check for the chmVPb class marker.
          if (node.querySelector('.chmVPb')) return;
          if (node.classList.contains('chmVPb')) return;

          // Extract sender name
          const senderEl = node.querySelector('div.poVWob');
          const sender = senderEl?.textContent?.trim() || '';

          // No sender element = bot's own message — skip it
          if (!sender) return;

          // Extract message text
          const textEl = node.querySelector('div[jsname="dTKtvb"]');
          const text = textEl?.textContent?.trim() || '';
          if (!text) return;

          // Dedup check
          const msgEl = node.querySelector('[data-message-id]');
          const msgId = msgEl?.getAttribute('data-message-id') || '';
          if (isDuplicate(msgId, text)) return;

          console.log(`[MeetBeats] Chat received: ${sender}: ${text}`);
          (window as any).__meetbeats_onChatMessage(sender, text);
        };

        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
              if (!(node instanceof HTMLElement)) continue;

              // Only process direct message items (jsname="Ypafjf")
              if (node.getAttribute('jsname') === 'Ypafjf') {
                processMessage(node);
              } else {
                // Check children for message items
                const msgItems = node.querySelectorAll('div[jsname="Ypafjf"]');
                msgItems.forEach((item) => processMessage(item as HTMLElement));
              }
            }
          }
        });

        observer.observe(container, { childList: true, subtree: true });
        (window as any).__meetbeats_observerAlive = true;
        console.log('[MeetBeats] MutationObserver active on chat container');

        // Self-healing: detect when Meet re-renders the chat container (detaches our node).
        // When that happens, disconnect the dead observer and re-attach to the new container.
        const watchdog = setInterval(() => {
          if (!document.body.contains(container)) {
            console.log('[MeetBeats] Chat container was detached from DOM — re-attaching observer');
            observer.disconnect();
            (window as any).__meetbeats_observerAlive = false;
            clearInterval(watchdog);
            retryCount = 0;
            setupObserver();
          }
        }, 3000);
      };

      setupObserver();
    }, containerCandidates);

    this.running = true;
    logger.info('Chat monitor started');

    // Periodic health check — re-open chat panel and re-inject observer if dead
    this.healthCheckInterval = setInterval(async () => {
      if (!this.running) return;
      try {
        const p = this.meetManager.getPage();

        // Check if chat panel is open
        let chatOpen = false;
        for (const inputSel of selectors.chatInputCandidates) {
          chatOpen = await p.locator(inputSel).first().isVisible().catch(() => false);
          if (chatOpen) break;
        }
        if (!chatOpen) {
          logger.warn('Chat panel closed — re-opening');
          await this.meetManager.openChatPanel();
        }

        // Check if observer is still alive (page re-render kills it)
        const observerAlive = await p.evaluate(() => {
          return !!(window as any).__meetbeats_observerAlive;
        }).catch(() => false);

        if (!observerAlive) {
          logger.warn('Chat observer dead — re-injecting');
          // Re-expose the callback if the page context was destroyed
          try {
            await p.exposeFunction('__meetbeats_onChatMessage', (sender: string, text: string) => {
              const message: ChatMessage = {
                sender,
                text,
                timestamp: new Date(),
              };
              logger.info(`Chat message from ${sender}: ${text}`);
              this.emit('message', message);
            });
          } catch {
            // Already exposed in this context — that's fine
          }

          await p.evaluate((candidates: string[]) => {
            const findChatContainer = (): Element | null => {
              for (const sel of candidates) {
                const el = document.querySelector(sel);
                if (el) return el;
              }
              return null;
            };

            const container = findChatContainer();
            if (!container) {
              console.log('[MeetBeats] Re-inject: no chat container found');
              return;
            }

            console.log('[MeetBeats] Re-injecting chat observer');

            const seenMessageIds = new Set<string>();
            const recentTexts = new Map<string, number>();

            const isDuplicate = (msgId: string, text: string): boolean => {
              if (msgId && seenMessageIds.has(msgId)) return true;
              if (msgId) seenMessageIds.add(msgId);
              const now = Date.now();
              const lastSeen = recentTexts.get(text);
              if (lastSeen && now - lastSeen < 2000) return true;
              recentTexts.set(text, now);
              return false;
            };

            const processMessage = (node: HTMLElement) => {
              if (node.querySelector('.chmVPb')) return;
              if (node.classList.contains('chmVPb')) return;
              const senderEl = node.querySelector('div.poVWob');
              const sender = senderEl?.textContent?.trim() || '';
              if (!sender) return;
              const textEl = node.querySelector('div[jsname="dTKtvb"]');
              const text = textEl?.textContent?.trim() || '';
              if (!text) return;
              const msgEl = node.querySelector('[data-message-id]');
              const msgId = msgEl?.getAttribute('data-message-id') || '';
              if (isDuplicate(msgId, text)) return;
              console.log(`[MeetBeats] Chat received: ${sender}: ${text}`);
              (window as any).__meetbeats_onChatMessage(sender, text);
            };

            const observer = new MutationObserver((mutations) => {
              for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                  if (!(node instanceof HTMLElement)) continue;
                  if (node.getAttribute('jsname') === 'Ypafjf') {
                    processMessage(node);
                  } else {
                    node.querySelectorAll('div[jsname="Ypafjf"]').forEach((item) => processMessage(item as HTMLElement));
                  }
                }
              }
            });

            observer.observe(container, { childList: true, subtree: true });
            (window as any).__meetbeats_observerAlive = true;
            console.log('[MeetBeats] Chat observer re-injected successfully');

            // Watchdog for this observer too
            const watchdog = setInterval(() => {
              if (!document.body.contains(container)) {
                console.log('[MeetBeats] Chat container detached from DOM');
                observer.disconnect();
                clearInterval(watchdog);
                (window as any).__meetbeats_observerAlive = false;
              }
            }, 3000);
          }, containerCandidates);
        }
      } catch {
        // Page may not be available
      }
    }, 10000);
  }

  isRunning(): boolean {
    return this.running;
  }

  stop(): void {
    this.running = false;
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    logger.info('Chat monitor stopped');
  }
}
