export interface QuizListEntry {
  index: string;
  title: string;
  difficulty?: number;
  quiz?: {
    index?: string;
    sequence?: number;
    url_slug?: string;
  };
  exam?: {
    index?: string;
    sequence?: number;
    url_slug?: string;
  };
}

export interface QuizPageResponse {
  result: boolean;
  data: QuizListEntry[];
  total: number;
}

export interface QuizDumpDetail {
  index: string;
  title: string;
  difficulty?: number;
  examIndex?: string;
  examSequence?: number;
  examUrlSlug?: string;
  quizSequence?: number;
  quizUrlSlug?: string;
  quizNumber: number;
  sourceUrl: string;
  contentsHtml: string;
  contentsMarkdown: string;
  metaDataText?: string;
  inputExamples: string[];
  outputExamples: string[];
  runScreenExample?: string;
  answerLanguages: string[];
  fetchedAt: string;
}

export interface DumpConfig {
  pages: number;
  limit: number;
  outDir: string;
  delayMs: number;
  cookie?: string;
}

export interface DumpFailure {
  index: string;
  title: string;
  reason: string;
}

export interface DumpSummary {
  totalFromApi: number;
  requestedPages: number;
  listed: number;
  dumped: number;
  failed: number;
  outputDir: string;
  failures: DumpFailure[];
}

export type DumpProgressEvent =
  | {type: "page"; page: number; pages: number}
  | {type: "quiz"; current: number; total: number; title: string}
  | {type: "saved"; path: string}
  | {type: "warning"; message: string}
  | {type: "error"; message: string};

export interface LectureSectionProgress {
  order: number;
  title: string;
  completedLessons: number;
  totalLessons: number;
}

export interface LectureProgressSummary {
  title: string;
  lectureSequence?: number;
  lectureIndex?: string;
  sourceUrl: string;
  lastLesson?: string;
  completedLessons?: number;
  totalLessons?: number;
  progressPercent?: number;
  sections: LectureSectionProgress[];
  fetchedAt: string;
  rawHints: Record<string, unknown>;
}
