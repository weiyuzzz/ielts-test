import { errorResponse, HttpError } from "@/lib/server/user";
import { activateBank, getBankDetail, importBank, listBanks } from "@/lib/server/bank-service";
import { ensureSeed } from "@/lib/server/seed";

export const dynamic = "force-dynamic";

/** When ADMIN_TOKEN is set, write operations require the matching x-admin-token header. */
function assertAdmin(req: Request, write = false) {
  if (!write) return;
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return; // local development mode
  if (req.headers.get("x-admin-token") !== expected) throw new HttpError(401, "Admin token required", "admin_unauthorized");
}

function onError(e: unknown) {
  return errorResponse(e);
}

export async function GET(req: Request) {
  try {
    await ensureSeed();
    const id = new URL(req.url).searchParams.get("id");
    if (id) return Response.json(await getBankDetail(Number(id)));
    return Response.json({ banks: await listBanks(), protected: !!process.env.ADMIN_TOKEN });
  } catch (e) {
    return onError(e);
  }
}

export async function POST(req: Request) {
  try {
    assertAdmin(req, true);
    const body = (await req.json().catch(() => ({}))) as { bank?: unknown; activate?: boolean };
    const result = await importBank(body.bank ?? body, body.activate === true);
    return Response.json(result, { status: 201 });
  } catch (e) {
    return onError(e);
  }
}

export async function PUT(req: Request) {
  try {
    assertAdmin(req, true);
    const body = (await req.json().catch(() => ({}))) as { id?: number };
    if (!body.id || !Number.isInteger(body.id)) throw new HttpError(400, "id required", "invalid_id");
    return Response.json(await activateBank(body.id));
  } catch (e) {
    return onError(e);
  }
}
