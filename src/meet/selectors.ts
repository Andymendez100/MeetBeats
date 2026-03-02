/**
 * Centralized DOM selectors for Google Meet UI.
 * When Google updates the Meet UI, only this file needs updating.
 * Prefer ARIA-based selectors for stability.
 *
 * Arrays = ordered fallbacks (tried first → last). Google changes these often.
 */
export const selectors = {
  // Pre-join screen
  nameInput: 'input[aria-label="Your name"]',
  cameraButton: '[aria-label*="camera" i][role="button"], [aria-label*="Turn off camera" i]',
  micButton: '[aria-label*="microphone" i][role="button"], [aria-label*="Turn off microphone" i]',
  joinButton: '[aria-label="Join now"], button:has-text("Join now"), button:has-text("Ask to join"), button:has-text("Switch here")',
  dismissButton: 'button:has-text("Got it"), button:has-text("Dismiss")',

  // In-call UI — chat button fallbacks (Google changes aria-labels across versions)
  chatButtonCandidates: [
    'button[aria-label="Chat with everyone"]',
    'button[aria-label="Chat"]',
    'button[aria-label="Open chat"]',
    'button[aria-label="In-call messages"]',
    'button[aria-label*="chat" i]',
  ],
  // Legacy single selector (kept for backward compat)
  chatButton: 'button[aria-label="Chat with everyone"]',
  chatPanel: '#ME4pNd',
  // Chat input fallbacks
  chatInputCandidates: [
    'textarea[aria-label="Send a message"]',
    'textarea[aria-label="Send a message to everyone"]',
    '[aria-label="Send a message"][contenteditable="true"]',
    '[aria-label="Send a message to everyone"][contenteditable="true"]',
    'textarea[aria-label*="message" i]',
  ],
  chatInput: 'textarea[aria-label="Send a message"]',
  chatSendButton: 'button[aria-label="Send a message"]',

  // Chat message container fallbacks (attach MutationObserver here)
  chatContainerCandidates: [
    'div[jsname="xySENc"]',
    '#ME4pNd',
    '[aria-label="Chat messages"]',
    '[role="log"]',
  ],
  chatMessageList: 'div[jsname="xySENc"]',
  // Individual message wrapper
  chatMessageItem: 'div[jsname="Ypafjf"]',
  // Sender name (only present on other people's messages)
  chatMessageSender: 'div.poVWob',
  // Message text content
  chatMessageText: 'div[jsname="dTKtvb"]',
  // Class on bot's own messages (skip these)
  chatOwnMessageMarker: 'chmVPb',

  // Leave call
  leaveButton: '[aria-label="Leave call"]',

  // Settings
  settingsButton: 'button[aria-label="Settings"]',
  moreOptionsButton: 'button[aria-label="More options"]',

  // Participant count / other
  peopleCount: '[aria-label*="participant" i]',
};
