/**
 * Centralized DOM selectors for Google Meet UI.
 * When Google updates the Meet UI, only this file needs updating.
 * Prefer ARIA-based selectors for stability.
 */
export const selectors = {
  // Pre-join screen
  nameInput: 'input[aria-label="Your name"]',
  cameraButton: '[aria-label*="camera" i][role="button"], [aria-label*="Turn off camera" i]',
  micButton: '[aria-label*="microphone" i][role="button"], [aria-label*="Turn off microphone" i]',
  joinButton: '[aria-label="Join now"], button:has-text("Join now"), button:has-text("Ask to join")',
  dismissButton: 'button:has-text("Got it"), button:has-text("Dismiss")',

  // In-call UI
  chatButton: '[aria-label*="chat" i][role="button"], button[aria-label*="Chat with everyone" i]',
  chatPanel: '[aria-label="Chat with everyone"]',
  chatInput: 'textarea[aria-label*="Send a message" i], div[aria-label*="Send a message" i]',
  chatSendButton: 'button[aria-label="Send a message"]',
  chatMessages: '[data-is-chat-message="true"], div[class*="oIy2qc"]',

  // Chat message internals
  chatMessageSender: '[class*="YTbUzc"], [data-sender-name]',
  chatMessageText: '[class*="oIy2qc"] span, [data-message-text]',

  // Leave call
  leaveButton: '[aria-label="Leave call"]',

  // Participant count / other
  peopleCount: '[aria-label*="participant" i]',
};
