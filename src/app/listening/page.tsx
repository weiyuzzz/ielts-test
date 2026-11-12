import { ComingSoon } from "@/components/coming-soon";

export default function Listening() {
  return (
    <ComingSoon
      title="Listening"
      subtitle="Four-section computer-delivered listening tests with timed review."
      features={[
        { name: "Full tests", desc: "Four sections, 40 questions, single-play audio and 2-minute review, as in computer-delivered IELTS." },
        { name: "Question-type drills", desc: "Form completion, maps, multiple choice and matching, practised separately." },
        { name: "Transcript review", desc: "Sentence-level transcript aligned with the audio, showing where each answer occurs." },
      ]}
      preview={{ label: "Section 1 · Form completion", items: ["Name of caller: ________", "Preferred date: ________", "Number of guests: ________"] }}
    />
  );
}
