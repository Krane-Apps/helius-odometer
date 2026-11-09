import { randomBytes } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(8).toString("hex")}`;
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}
