export interface Question {
  c: string; // Category
  q: string; // Question text
  options: string[];
  ans: number;
}

export interface Participant {
  name: string;
  email: string;
  registeredAt: string;
  status: 'active' | 'completed' | 'terminated';
  questionIndices: number[];
  currentIndex: number;
  answers: Answer[];
  score: number;
  totalQuestions: number;
  startedAt?: string;
  completedAt?: string;
  terminatedAt?: string;
  terminatedReason?: string;
}

export interface Answer {
  chosen: number | null;
  correct: number;
  isCorrect: boolean;
}

