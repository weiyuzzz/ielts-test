import { redirect } from "next/navigation";

/** The Lip Sync Lab now lives on the settings page. */
export default function LipSyncLabPage() {
  redirect("/settings#lipsync-lab");
}
