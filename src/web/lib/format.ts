/** "M:SS" (or "H:MM:SS" past an hour). */
export function fmtTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** Seconds with at most 2 decimals, no trailing zeros. */
export function fmtSeconds(seconds: number): string {
  return String(Math.round(seconds * 100) / 100);
}

/** Accepts "83.5", "1:23.5" or "1:02:03"; returns null when it is not a time. */
export function parseTime(text: string): number | null {
  const parts = text.trim().split(":");
  if (parts.length === 0 || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$|^\.\d+$/.test(p.trim()))) return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

export const MIN_CLIP_SECONDS = 3;
export const MAX_CLIP_SECONDS = 180;

/** Contract validity rule: inside the video and 3-180 s long. */
export function validateRange(start: number, end: number, duration: number): string | null {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "Enter a valid time";
  if (start < 0) return "Start cannot be before 0:00";
  if (end > duration + 1e-6) return `End cannot be after the end of the video (${fmtTime(duration)})`;
  if (end <= start) return "End must be after start";
  const length = end - start;
  if (length < MIN_CLIP_SECONDS - 1e-6) return `Clip must be at least ${MIN_CLIP_SECONDS} s long`;
  if (length > MAX_CLIP_SECONDS + 1e-6) return `Clip must be at most ${MAX_CLIP_SECONDS} s long`;
  return null;
}

/** Floors to 0.1 s; the epsilon keeps 126.9 from becoming 126.8 through float error. */
export const floor1 = (n: number) => Math.floor(n * 10 + 1e-6) / 10;
export const round2 = (n: number) => Math.round(n * 100) / 100;
export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
