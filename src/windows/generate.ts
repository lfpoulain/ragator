import { STEP_SECONDS, WINDOW_MIN_SECONDS, WINDOW_SECONDS } from '../core/versions.js';

export interface Window {
  startS: number;
  endS: number;
}

export function generateWindows(
  durationS: number,
  windowSeconds = WINDOW_SECONDS,
  stepSeconds = STEP_SECONDS,
): Window[] {
  if (durationS <= 0) return [];
  const windows: Window[] = [];
  let start = 0;
  while (start < durationS) {
    const end = Math.min(start + windowSeconds, durationS);
    windows.push({ startS: start, endS: end });
    if (end >= durationS) break;
    start += stepSeconds;
  }
  const last = windows[windows.length - 1];
  if (
    windows.length > 1 &&
    last !== undefined &&
    durationS - last.startS < WINDOW_MIN_SECONDS
  ) {
    windows.pop();
    const previous = windows[windows.length - 1];
    if (previous) previous.endS = durationS;
  }
  return windows;
}

export function entryEndForOverlap(startS: number, endS: number | null): number {
  return Math.max(endS ?? startS, startS + 1);
}

export function windowsForEntry(
  windows: Window[],
  startS: number,
  endS: number | null,
): number[] {
  const entryEnd = entryEndForOverlap(startS, endS);
  const result: number[] = [];
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    if (w && startS <= w.endS && entryEnd > w.startS) {
      result.push(i);
    }
  }
  return result;
}
