import { getCurrentUser } from "@/lib/server/user";
import { capabilities } from "@/lib/ai/registry";
import { LipSyncLab } from "./lip-sync-lab";

export const dynamic = "force-dynamic";

export default async function LipSyncLabPage() {
  const user = await getCurrentUser();
  const caps = capabilities();
  return (
    <LipSyncLab
      serverTts={caps.tts.location === "server"}
      profiles={caps.tts.profiles.map((p) => ({ id: p.id, name: p.name }))}
      defaultProfileId={caps.tts.defaultProfileId}
      gender={user?.examinerGender === "male" ? "male" : "female"}
    />
  );
}
