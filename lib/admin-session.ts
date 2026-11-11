import { cookies } from "next/headers";
import { ADMIN_COOKIE_NAME, ADMIN_PASSWORD } from "./admin-auth";

/**
 * Defense in depth for admin route handlers: proxy.ts already blocks
 * unauthenticated requests, but each admin API route re-checks the session.
 */
export async function isAdminSession(): Promise<boolean> {
  const store = await cookies();
  return store.get(ADMIN_COOKIE_NAME)?.value === ADMIN_PASSWORD;
}
