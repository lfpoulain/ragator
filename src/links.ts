import { LINK_BACK_S } from './core/versions.js';

export function videoLink(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function timestampedLink(videoId: string, startS: number): string {
  const t = Math.max(0, Math.floor(startS) - LINK_BACK_S);
  return `https://www.youtube.com/watch?v=${videoId}&t=${t}s`;
}
