import { differenceInMinutes, max, min, parseISO } from "date-fns";
import type { TimelineWindow } from "./model";

export function clampToWindow(start: Date, end: Date, win: TimelineWindow) {
  const s = max([start, win.start]);
  const e = min([end, win.end]);
  return { start: s, end: e };
}

export function minutesInWindow(win: TimelineWindow) {
  return Math.max(1, differenceInMinutes(win.end, win.start));
}

export function dateToX(d: Date, win: TimelineWindow, widthPx: number) {
  const total = minutesInWindow(win);
  const m = differenceInMinutes(d, win.start);
  return (m / total) * widthPx;
}

export function isoToDate(iso: string) {
  return parseISO(iso);
}

