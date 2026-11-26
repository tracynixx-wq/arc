import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

type TelegramWebAppUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
};

type VerifiedTelegramData = {
  user: TelegramWebAppUser;
  authDate: number;
};

export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 600,
): VerifiedTelegramData | null {
  if (!initData || initData.length > 10_000) return null;

  const params = new URLSearchParams(initData);
  const suppliedHash = params.get("hash");
  const authDateValue = params.get("auth_date");
  const userValue = params.get("user");

  if (!suppliedHash || !/^[a-f0-9]{64}$/i.test(suppliedHash) || !authDateValue || !userValue) {
    return null;
  }

  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = createHmac("sha256", secretKey).update(dataCheckString).digest();
  const receivedHash = Buffer.from(suppliedHash, "hex");

  if (receivedHash.length !== expectedHash.length || !timingSafeEqual(receivedHash, expectedHash)) {
    return null;
  }

  const authDate = Number(authDateValue);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(authDate) || authDate > now + 60 || now - authDate > maxAgeSeconds) {
    return null;
  }

  try {
    const user = JSON.parse(userValue) as TelegramWebAppUser;
    if (!Number.isSafeInteger(user.id) || user.id <= 0) return null;
    return { user, authDate };
  } catch {
    return null;
  }
}
