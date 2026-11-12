import { capabilities } from "@/lib/ai/registry";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(capabilities());
}
