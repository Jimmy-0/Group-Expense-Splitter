// Client-only state: navigation and per-device preferences kept in localStorage.

export function navigate(path: string): void {
  history.pushState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}

export interface RecentGroup {
  id: string;
  name: string;
}

const RECENT_KEY = "recentGroups";

export function recentGroups(): RecentGroup[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as RecentGroup[];
  } catch {
    return [];
  }
}

export function rememberGroup(group: RecentGroup): void {
  const rest = recentGroups().filter((g) => g.id !== group.id);
  localStorage.setItem(RECENT_KEY, JSON.stringify([group, ...rest].slice(0, 10)));
}

/** Which member this device belongs to; used as the default payer. */
export function getMe(groupId: string): number | null {
  const v = Number(localStorage.getItem(`me:${groupId}`));
  return Number.isInteger(v) && v > 0 ? v : null;
}

export function setMe(groupId: string, memberId: number): void {
  localStorage.setItem(`me:${groupId}`, String(memberId));
}
