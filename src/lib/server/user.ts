import { cookies } from "next/headers";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";

export const UID_COOKIE = "ielts_uid";

/**
 * Lightweight anonymous identity: a random key in an httpOnly cookie (set by src/proxy.ts)
 * maps to a users row. Replaceable by real auth later without schema changes.
 */
export async function getCurrentUser() {
  const store = await cookies();
  const key = store.get(UID_COOKIE)?.value;
  if (!key || !/^[a-zA-Z0-9-]{16,64}$/.test(key)) return null;
  const found = await db.select().from(users).where(eq(users.anonKey, key)).limit(1);
  if (found.length) return found[0];
  const [created] = await db.insert(users).values({ anonKey: key }).onConflictDoNothing().returning();
  if (created) return created;
  return (await db.select().from(users).where(eq(users.anonKey, key)).limit(1))[0] ?? null;
}

export async function requireUser() {
  const u = await getCurrentUser();
  if (!u) throw new HttpError(401, "No session cookie. Reload the page.");
  return u;
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export function errorResponse(e: unknown) {
  if (e instanceof HttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
  console.error(e);
  return Response.json({ error: "Internal server error" }, { status: 500 });
}
