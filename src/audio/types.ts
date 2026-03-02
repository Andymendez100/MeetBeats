export interface Song {
  title: string;
  url: string;
  duration: number; // seconds
  filePath?: string; // local cache path after download
  requestedBy: string;
}

export type LoopMode = 'off' | 'song' | 'queue';
