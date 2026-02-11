import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import pino from "pino";
import type { AuditEvent } from "./models.js";

const STATE_DIR = "state";
const EVENTS_FILE = `${STATE_DIR}/events.jsonl`;

let logger: pino.Logger | null = null;

export function getLogger(): pino.Logger {
  if (!logger) {
    logger = pino({
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:HH:MM:ss", destination: 2 },
      },
    });
  }
  return logger;
}

export function emitEvent(
  event: AuditEvent["event"],
  data: Record<string, unknown> = {},
): void {
  const entry: AuditEvent = {
    timestamp: new Date().toISOString(),
    event,
    data,
  };

  mkdirSync(dirname(EVENTS_FILE), { recursive: true });
  appendFileSync(EVENTS_FILE, JSON.stringify(entry) + "\n");
  getLogger().info({ event, ...data }, event);
}
