import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { PolicySchema, type Policy, type ScheduleWindowType } from "./models.js";

const DAY_MAP: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};

let cachedPolicy: Policy | null = null;

export function loadPolicy(configPath = "config/policy.yaml"): Policy {
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(raw);
  const policy = PolicySchema.parse(parsed);
  cachedPolicy = policy;
  return policy;
}

export function getPolicy(): Policy {
  if (!cachedPolicy) return loadPolicy();
  return cachedPolicy;
}

export function isInsideScheduleWindow(
  policy: Policy,
  now: Date = new Date(),
): boolean {
  // Convert to user timezone
  const tzNow = new Date(
    now.toLocaleString("en-US", { timeZone: policy.timezone }),
  );
  const dayOfWeek = tzNow.getDay();
  const hhmm =
    tzNow.getHours().toString().padStart(2, "0") +
    ":" +
    tzNow.getMinutes().toString().padStart(2, "0");

  return policy.schedule.some((w: ScheduleWindowType) => {
    return DAY_MAP[w.day] === dayOfWeek && hhmm >= w.start && hhmm <= w.end;
  });
}

export function getWeekEnd(policy: Policy, now: Date = new Date()): Date {
  const tzNowStr = now.toLocaleString("en-US", { timeZone: policy.timezone });
  const tzNow = new Date(tzNowStr);
  const dayOfWeek = tzNow.getDay(); // 0=Sun
  const daysUntilSunday = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
  const weekEnd = new Date(tzNow);
  weekEnd.setDate(weekEnd.getDate() + daysUntilSunday);
  weekEnd.setHours(23, 59, 59, 999);
  return weekEnd;
}

export function getRemainingBudget(
  policy: Policy,
  tokensUsed: number,
): number {
  return Math.max(
    0,
    policy.weekly_target_tokens - tokensUsed - policy.weekly_min_reserve_tokens,
  );
}

export function getHoursLeft(policy: Policy, now: Date = new Date()): number {
  const weekEnd = getWeekEnd(policy, now);
  const msLeft = weekEnd.getTime() - now.getTime();
  return Math.max(msLeft / (1000 * 60 * 60), 0.25);
}

export function getRequiredBurnRate(
  remainingBudget: number,
  hoursLeft: number,
): number {
  return remainingBudget / Math.max(hoursLeft, 0.25);
}
