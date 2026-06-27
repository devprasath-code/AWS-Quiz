import { AdminSettings } from "../types";

export const PARTICIPANT_PREFIX = "participant:";
export const ADMIN_KEY = "admin:settings";

export async function storeGet<T>(key: string): Promise<T | null> {
  try {
    const res = await (window as any).storage.get(key, true);
    if (!res || !res.value) return null;
    try { return JSON.parse(res.value); } catch { return null; }
  } catch (e) { return null; }
}

export async function storeSet(key: string, obj: any): Promise<boolean> {
  try {
    const res = await (window as any).storage.set(key, JSON.stringify(obj), true);
    return !!res;
  } catch (e) { return false; }
}

export async function storeListKeys(prefix: string): Promise<string[]> {
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
