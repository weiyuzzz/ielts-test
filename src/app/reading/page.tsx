import { ComingSoon } from "@/components/coming-soon";

export default function Reading() {
  return (
    <ComingSoon
      title="Reading"
      subtitle="Academic and General Training passages in a split-screen exam interface."
      features={[
        { name: "Timed passages", desc: "60-minute tests with three passages, highlighting and notes." },
        { name: "Question strategies", desc: "True/False/Not Given, headings and summary completion, each with targeted practice." },
        { name: "Evidence locator", desc: "After submitting, see the exact sentence in the passage that supports each answer." },
      ]}
      preview={{ label: "Passage 1 · True / False / Not Given", items: ["The author visited the site in 1998.", "Funding was provided by the government.", "Most researchers agreed with the theory."] }}
    />
  );
}
