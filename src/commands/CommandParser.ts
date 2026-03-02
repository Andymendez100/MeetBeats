import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

export interface ParsedCommand {
  command: string;
  args: string;
  rawMessage: string;
  sender: string;
}

const VALID_COMMANDS = new Set([
  'play',
  'skip',
  'stop',
  'pause',
  'resume',
  'queue',
  'nowplaying',
  'np',
  'volume',
  'playlist',
  'shuffle',
  'loop',
  'remove',
  'help',
  'exit',
]);

export function parseCommand(sender: string, text: string): ParsedCommand | null {
  const trimmed = text.trim();

  // Accept both the configured prefix (default "!") and "/" as command prefixes
  const prefixes = [config.commandPrefix, '/'];
  const matchedPrefix = prefixes.find(p => trimmed.startsWith(p));
  if (!matchedPrefix) return null;

  const withoutPrefix = trimmed.slice(matchedPrefix.length);
  const spaceIndex = withoutPrefix.indexOf(' ');

  let command: string;
  let args: string;

  if (spaceIndex === -1) {
    command = withoutPrefix.toLowerCase();
    args = '';
  } else {
    command = withoutPrefix.slice(0, spaceIndex).toLowerCase();
    args = withoutPrefix.slice(spaceIndex + 1).trim();
  }

  if (!VALID_COMMANDS.has(command)) {
    logger.debug(`Unknown command: ${command}`);
    return null;
  }

  return { command, args, rawMessage: text, sender };
}
