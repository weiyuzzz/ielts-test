import { ReportView } from "./report-view";

export const dynamic = "force-dynamic";

export default async function ReportPage({ params }: PageProps<"/speaking/report/[id]">) {
  const { id } = await params;
  return <ReportView sessionId={id} />;
}
