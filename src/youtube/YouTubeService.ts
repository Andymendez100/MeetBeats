import { Innertube, UniversalCache } from 'youtubei.js';
import { logger } from '../utils/logger.js';
import { Song } from '../audio/types.js';

type InnertubeInstance = InstanceType<typeof Innertube>;

export class YouTubeService {
  private yt: InnertubeInstance | null = null;

  async init(): Promise<void> {
    this.yt = await Innertube.create({
      cache: new UniversalCache(true),
    });
    logger.info('YouTube service initialized');
  }

  getInnertube(): InnertubeInstance {
    if (!this.yt) throw new Error('YouTubeService not initialized. Call init() first.');
    return this.yt;
  }

  private getYt(): InnertubeInstance {
    return this.getInnertube();
  }

  async search(query: string): Promise<Omit<Song, 'requestedBy'> | null> {
    try {
      const results = await this.getYt().search(query, { type: 'video' });
      const videos = results.videos;

      if (!videos || videos.length === 0) {
        logger.warn(`No search results for: ${query}`);
        return null;
      }

      const video = videos[0] as any;
      const videoId = video.id || video.video_id;
      const durationText: string = video.duration?.text || '0:00';

      return {
        title: video.title?.text || video.title || 'Unknown',
        url: `https://www.youtube.com/watch?v=${videoId}`,
        duration: this.parseDuration(durationText),
      };
    } catch (err) {
      logger.error(`YouTube search failed: ${err}`);
      return null;
    }
  }

  async getInfo(url: string): Promise<Omit<Song, 'requestedBy'> | null> {
    try {
      const videoId = this.extractVideoId(url);
      if (!videoId) {
        logger.warn(`Could not extract video ID from: ${url}`);
        return null;
      }

      const info = await this.getYt().getBasicInfo(videoId);
      const details = info.basic_info;

      return {
        title: details.title || 'Unknown',
        url: `https://www.youtube.com/watch?v=${videoId}`,
        duration: details.duration || 0,
      };
    } catch (err) {
      logger.error(`Failed to get video info: ${err}`);
      return null;
    }
  }

  async getPlaylist(url: string): Promise<Omit<Song, 'requestedBy'>[]> {
    try {
      const playlistId = this.extractPlaylistId(url);
      if (!playlistId) {
        logger.warn(`Could not extract playlist ID from: ${url}`);
        return [];
      }

      const playlist = await this.getYt().getPlaylist(playlistId);
      const songs: Omit<Song, 'requestedBy'>[] = [];

      for (const item of playlist.items) {
        const video = item as any;
        const videoId = video.id || video.video_id;
        if (!videoId) continue;

        songs.push({
          title: video.title?.text || video.title || 'Unknown',
          url: `https://www.youtube.com/watch?v=${videoId}`,
          duration: this.parseDuration(video.duration?.text || '0:00'),
        });
      }

      logger.info(`Loaded ${songs.length} songs from playlist ${playlistId}`);
      return songs;
    } catch (err) {
      logger.error(`Failed to load playlist: ${err}`);
      return [];
    }
  }

  private extractVideoId(url: string): string | null {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/v\/([a-zA-Z0-9_-]{11})/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1];
    }

    // Maybe it's just a video ID
    if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;

    return null;
  }

  private extractPlaylistId(url: string): string | null {
    const match = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
  }

  private parseDuration(text: string): number {
    const parts = text.split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] || 0;
  }
}
