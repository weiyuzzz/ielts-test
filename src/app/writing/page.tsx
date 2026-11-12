import { ComingSoon } from "@/components/coming-soon";

export default function Writing() {
  return (
    <ComingSoon
      title="Writing"
      subtitle="Task 1 and Task 2 practice with criterion-based AI feedback."
      features={[
        { name: "Task 1 & Task 2", desc: "Timed writing editor with word count, covering Academic charts and General letters." },
        { name: "Four-criteria feedback", desc: "Task Response, Coherence & Cohesion, Lexical Resource and Grammar, using the same assessment engine as Speaking." },
        { name: "Sentence rewrites", desc: "Error explanations and more natural alternatives, each linked to your own sentences." },
      ]}
      preview={{ label: "Task 2 · Opinion essay", items: ["Introduction — paraphrase + position", "Body 1 — main reason + example", "Body 2 — second reason + example"] }}
    />
  );
}
