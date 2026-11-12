/** Original question bank written for this project (not copied from any third party). */
export interface SeedTopic {
  key: string;
  topic: string;
  part1?: string[];
  part2?: { text: string; cues: string[] };
  part3?: string[];
}

export const SEED_SET = { name: "Core Speaking Bank", season: "2026 Core", description: "Original practice questions covering common IELTS themes." };

export const SEED_TOPICS: SeedTopic[] = [
  { key: "hometown", topic: "Your hometown", part1: ["Where is your hometown?", "What do you like most about living there?", "Has your hometown changed much since you were a child?", "Would you like to live there in the future? Why or why not?"] },
  { key: "work-study", topic: "Work or studies", part1: ["Do you work or are you a student?", "Why did you choose that subject or job?", "What is the most difficult part of it?", "What would you like to do in the next few years?"] },
  { key: "mornings", topic: "Mornings", part1: ["Do you usually get up early?", "What do you normally do in the morning?", "Is your morning routine different at weekends?", "Do you think mornings are a good time to study?"] },
  { key: "music", topic: "Music", part1: ["What kind of music do you enjoy?", "When do you usually listen to music?", "Did you learn to play an instrument as a child?", "Has your taste in music changed over time?"] },
  { key: "weather", topic: "Weather", part1: ["What's the weather usually like where you live?", "What is your favourite kind of weather?", "Does the weather ever affect your mood?", "Do you check the weather forecast often?"] },
  { key: "reading", topic: "Reading", part1: ["Do you enjoy reading?", "What kinds of things do you read most often?", "Do you prefer paper books or e-books?", "Did you read a lot when you were younger?"] },
  {
    key: "skill",
    topic: "Learning a skill",
    part2: { text: "Describe a skill you learned that took a long time to master.", cues: ["what the skill was", "when and how you learned it", "what difficulties you faced", "and explain how you feel about this skill now"] },
    part3: ["Why do some people give up when learning something difficult?", "Is it better to learn practical skills at school or at work?", "How has technology changed the way people learn new skills?", "Do you think older people find it harder to learn than younger people?", "Which skills will be most valuable in the future?"],
  },
  {
    key: "place",
    topic: "A peaceful place",
    part2: { text: "Describe a quiet place you like to go to relax.", cues: ["where it is", "how often you go there", "what you do there", "and explain why it helps you relax"] },
    part3: ["Why do people find it hard to relax these days?", "Should cities provide more green spaces?", "How do people in your country usually spend their free time?", "Is noise pollution a serious problem in big cities?", "Do you think people will have more leisure time in the future?"],
  },
  {
    key: "help",
    topic: "Helping someone",
    part2: { text: "Describe a time when you helped someone.", cues: ["who you helped", "what the situation was", "how you helped", "and explain how you felt afterwards"] },
    part3: ["Why do some people enjoy helping others more than others do?", "Should schools teach children to volunteer?", "Are people less helpful to strangers than in the past?", "What role should governments play in helping people in need?", "Can technology make communities more supportive?"],
  },
  {
    key: "purchase",
    topic: "A recent purchase",
    part2: { text: "Describe something you bought recently that you are happy with.", cues: ["what it was", "where you bought it", "why you bought it", "and explain why you are happy with it"] },
    part3: ["Why do people often buy things they don't need?", "How has online shopping changed people's habits?", "Is advertising aimed at children acceptable?", "Do you think people today are more materialistic than before?", "What are the environmental effects of consumer culture?"],
  },
];
