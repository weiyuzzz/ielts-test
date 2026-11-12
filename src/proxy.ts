import { NextResponse, type NextRequest } from "next/server";

export function proxy(req: NextRequest) {
  if (req.cookies.get("ielts_uid")) return NextResponse.next();
  const id = crypto.randomUUID();
  // make it visible to server components in this same request
  req.cookies.set("ielts_uid", id);
  const res = NextResponse.next({ request: { headers: req.headers } });
  res.cookies.set("ielts_uid", id, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
  return res;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health).*)"] };
