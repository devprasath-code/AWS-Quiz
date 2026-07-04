import { AdminSettings } from "../types";

export const PARTICIPANT_PREFIX = "participant:";
export const ADMIN_KEY = "admin:settings";

/**
 * Check if the Google AI Studio storage API is available.
 * When running locally (e.g. via `npm run dev`), this will be false,
 * and we fall back to localStorage so both quiz and admin panels
 * can share data within the same browser.
 */
function hasNativeStorage(): boolean {
  try {
    const s = (window as any).storage;
    return !!(s && typeof s.get === "function" && typeof s.set === "function" && typeof s.list === "function");
  } catch {
    return false;
  }
}

// ─── localStorage fallback helpers ───────────────────────────────
// These mirror the AI Studio storage API shape using localStorage
// so the app works identically in local dev.

function localGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function localSet(key: string, obj: any): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

function localListKeys(prefix: string): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) keys.push(k);
    }
  } catch { /* ignore */ }
  return keys;
}

// ─── Public API (auto-selects native or localStorage) ────────────

export async function storeGet<T>(key: string): Promise<T | null> {
  if (!hasNativeStorage()) {
    return localGet<T>(key);
  }
  try {
    const res = await (window as any).storage.get(key, true);
    if (!res || !res.value) return null;
    try { return JSON.parse(res.value); } catch { return null; }
  } catch (e) { return null; }
}

export async function storeSet(key: string, obj: any): Promise<boolean> {
  if (!hasNativeStorage()) {
    return localSet(key, obj);
  }
  try {
    const res = await (window as any).storage.set(key, JSON.stringify(obj), true);
    return !!res;
  } catch (e) { return false; }
}

export async function storeListKeys(prefix: string): Promise<string[]> {
  if (!hasNativeStorage()) {
    return localListKeys(prefix);
  }
  try {
    const res = await (window as any).storage.list(prefix, true);
    return res && res.keys ? res.keys : [];
  } catch (e) { return []; }
}

export function getParticipantKey(email: string): string {
  return PARTICIPANT_PREFIX + email.toLowerCase().trim();
}

export async function loadAdminSettings(): Promise<AdminSettings> {
  const s = await storeGet<AdminSettings>(ADMIN_KEY);
  return s || { quizLive: false };
}
