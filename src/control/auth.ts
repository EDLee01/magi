import { createHash, randomBytes, randomUUID } from "node:crypto";

import { SessionStore } from "../session-store.js";

export interface PairingToken {
  deviceId: string;
  token: string;
  expiresAt: string;
}

export function createPairingToken(input: {
  store: SessionStore;
  deviceName: string;
  ttlMs?: number;
}): PairingToken {
  const token = `magi_${randomBytes(24).toString("base64url")}`;
  const deviceId = randomUUID();
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? 10 * 60_000)).toISOString();
  input.store.upsertDevice({
    id: deviceId,
    name: input.deviceName,
    tokenHash: hashToken(token),
    expiresAt,
    metadata: { paired: false }
  });
  return { deviceId, token, expiresAt };
}

export function validateDeviceToken(input: {
  store: SessionStore;
  deviceId: string | undefined;
  token: string | undefined;
}): boolean {
  if (!input.deviceId || !input.token) {
    return false;
  }
  const device = input.store.getDevice(input.deviceId);
  if (!device) {
    return false;
  }
  if (new Date(device.expiresAt).getTime() <= Date.now()) {
    return false;
  }
  return device.tokenHash === hashToken(input.token);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
