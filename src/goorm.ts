import vm from "node:vm";
import TurndownService from "turndown";
import type {QuizDumpDetail, QuizListEntry, QuizPageResponse} from "./types.js";

const GOORM_BASE_URL = "https://level.goorm.io";

const turndownService = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-"
});

turndownService.addRule("texconverterImage", {
  filter: (node) =>
    node.nodeName === "IMG" &&
    typeof (node as {getAttribute: (name: string) => string | null}).getAttribute === "function" &&
    Boolean((node as {getAttribute: (name: string) => string | null}).getAttribute("src")?.includes("/texconverter?")),
  replacement: (_, node) => {
    const src = (node as {getAttribute: (name: string) => string | null}).getAttribute("src") ?? "";
    const eqMatch = /[?&]eq=([^&]+)/.exec(src);
    if (!eqMatch) {
      return "";
    }

    const decoded = decodeURIComponent(eqMatch[1]);
    return ` $${decoded}$ `;
  }
});

turndownService.addRule("horizontalRule", {
  filter: "hr",
  replacement: () => "\n\n---\n\n"
});

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function toExamUrl(examSequence: number, examSlug: string, quizNumber: number): string {
  const encodedSlug = encodeURIComponent(examSlug);
  return `${GOORM_BASE_URL}/exam/${examSequence}/${encodedSlug}/quiz/${quizNumber}`;
}

function buildHeaders(accept: string, cookie?: string): HeadersInit {
  const headers: HeadersInit = {
    "user-agent": "dumpgoorm-cli/1.0",
    accept
  };

  if (cookie) {
    (headers as Record<string, string>).cookie = cookie;
  }

  return headers;
}

async function fetchTextWithCookie(url: string, cookie?: string): Promise<string> {
  const response = await fetch(url, {
    headers: buildHeaders("text/html,application/xhtml+xml", cookie)
  });

  if (!response.ok) {
    throw new Error(`요청 실패 (${response.status} ${response.statusText})`);
  }

  return response.text();
}

function parseInitialStateFromHtml(html: string): Record<string, unknown> {
  const marker = "window.__INITIAL_STATE__ = ";
  const start = html.indexOf(marker);
  if (start < 0) {
    throw new Error("__INITIAL_STATE__를 찾지 못했습니다.");
  }

  const scriptEnd = html.indexOf("</script>", start);
  if (scriptEnd < 0) {
    throw new Error("__INITIAL_STATE__ script 블록이 비정상입니다.");
  }

  const assignmentScript = html.slice(start, scriptEnd);
  const sandbox: Record<string, unknown> = {
    window: {},
    Date,
    Infinity,
    undefined
  };

  vm.runInNewContext(assignmentScript, sandbox, {timeout: 1000});
  const windowObject = sandbox.window as {__INITIAL_STATE__?: Record<string, unknown>} | undefined;

  if (!windowObject?.__INITIAL_STATE__) {
    throw new Error("__INITIAL_STATE__ 파싱에 실패했습니다.");
  }

  return windowObject.__INITIAL_STATE__;
}

export async function fetchQuizPage(page: number, limit: number, cookie?: string): Promise<QuizPageResponse> {
  const url = new URL("/api/algo/quizzes", GOORM_BASE_URL);
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", String(limit));

  const response = await fetch(url, {
    headers: buildHeaders("application/json", cookie)
  });

  if (!response.ok) {
    throw new Error(`문제 목록 조회 실패 (${response.status} ${response.statusText})`);
  }

  const body = (await response.json()) as QuizPageResponse;
  if (!body.result || !Array.isArray(body.data)) {
    throw new Error("문제 목록 응답 형식이 예상과 다릅니다.");
  }

  return body;
}

function findQuizNumberFromState(state: Record<string, unknown>, targetQuizIndex: string): number {
  const exam = state.exam as Record<string, unknown> | undefined;
  const examData = exam?.examData as Record<string, unknown> | undefined;
  const totalQuizList = examData?.totalQuizList as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(totalQuizList)) {
    return 1;
  }

  const position = totalQuizList.findIndex((quiz) => quiz.index === targetQuizIndex);
  return position >= 0 ? position + 1 : 1;
}

function getCurrentQuizFromState(state: Record<string, unknown>): Record<string, unknown> {
  const exam = state.exam as Record<string, unknown> | undefined;
  const currentQuiz = exam?.currentQuiz as Record<string, unknown> | undefined;
  if (!currentQuiz) {
    throw new Error("현재 문제 데이터를 찾지 못했습니다.");
  }

  return currentQuiz;
}

export async function fetchQuizDetailFromExamPage(entry: QuizListEntry, cookie?: string): Promise<QuizDumpDetail> {
  const examSequence = entry.exam?.sequence;
  const examSlug = entry.exam?.url_slug;

  if (!examSequence || !examSlug) {
    throw new Error("문제의 exam sequence/url_slug가 없어 상세 조회가 불가능합니다.");
  }

  let quizNumber = 1;
  let url = toExamUrl(examSequence, examSlug, quizNumber);
  let html = await fetchTextWithCookie(url, cookie);
  let state = parseInitialStateFromHtml(html);
  let currentQuiz = getCurrentQuizFromState(state);

  if (currentQuiz.index !== entry.index) {
    const inferredQuizNumber = findQuizNumberFromState(state, entry.index);
    if (inferredQuizNumber !== 1) {
      quizNumber = inferredQuizNumber;
      url = toExamUrl(examSequence, examSlug, quizNumber);
      html = await fetchTextWithCookie(url, cookie);
      state = parseInitialStateFromHtml(html);
      currentQuiz = getCurrentQuizFromState(state);
    }
  }

  if (currentQuiz.index !== entry.index) {
    throw new Error(
      `조회된 quiz index(${String(currentQuiz.index)})가 기대한 index(${entry.index})와 다릅니다.`
    );
  }

  const contentsHtml = typeof currentQuiz.contents === "string" ? currentQuiz.contents : "";
  const markdown = normalizeWhitespace(turndownService.turndown(contentsHtml));

  return {
    index: entry.index,
    title: String(currentQuiz.title ?? entry.title),
    difficulty: entry.difficulty,
    examIndex: entry.exam?.index,
    examSequence: examSequence,
    examUrlSlug: examSlug,
    quizSequence: entry.quiz?.sequence,
    quizUrlSlug: entry.quiz?.url_slug,
    quizNumber,
    sourceUrl: url,
    contentsHtml,
    contentsMarkdown: markdown,
    metaDataText:
      typeof currentQuiz.metaData === "string" ? normalizeWhitespace(currentQuiz.metaData) : undefined,
    inputExamples: Array.isArray(currentQuiz.inputExample)
      ? currentQuiz.inputExample.map((value) => String(value))
      : [],
    outputExamples: Array.isArray(currentQuiz.outputExample)
      ? currentQuiz.outputExample.map((value) => String(value))
      : [],
    runScreenExample:
      typeof currentQuiz.runScreenExample === "string" ? currentQuiz.runScreenExample : undefined,
    answerLanguages: Array.isArray(currentQuiz.answer_language)
      ? currentQuiz.answer_language.map((value) => String(value))
      : [],
    fetchedAt: new Date().toISOString()
  };
}
