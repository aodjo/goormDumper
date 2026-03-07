import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import type {LectureProgressSummary, LectureSectionProgress} from "./types.js";

const EDU_BASE_URL = "https://edu.goorm.io";

type UnknownRecord = Record<string, unknown>;

interface LectureProgressDumpOptions {
  outDir: string;
  cookie?: string;
  learnUrl?: string;
  lectureSequence?: number;
  lectureIndex?: string;
  lectureTitleQuery?: string;
}

/**
 * 값이 일반 객체인지 판별합니다.
 *
 * @param value 검사할 값
 * @return 일반 객체 여부
 */
function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Goorm 요청용 공통 헤더를 구성합니다.
 *
 * @param accept Accept 헤더 값
 * @param cookie 로그인 쿠키 문자열
 * @return fetch 요청 헤더 객체
 */
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

/**
 * HTML에서 `window.__INITIAL_STATE__`를 실행해 상태 객체를 추출합니다.
 *
 * @param html 강의 페이지 HTML
 * @return 파싱된 초기 상태 객체
 */
function parseInitialStateFromHtml(html: string): UnknownRecord {
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

  vm.runInNewContext(assignmentScript, sandbox, {timeout: 1500});
  const windowObject = sandbox.window as {__INITIAL_STATE__?: UnknownRecord} | undefined;
  if (!windowObject?.__INITIAL_STATE__) {
    throw new Error("__INITIAL_STATE__ 파싱에 실패했습니다.");
  }

  return windowObject.__INITIAL_STATE__;
}

/**
 * JSON API를 요청해 응답 본문을 반환합니다.
 *
 * @param url 요청 URL
 * @param cookie 로그인 쿠키 문자열
 * @return 파싱된 JSON 데이터
 */
async function fetchJson(url: string, cookie?: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: buildHeaders("application/json", cookie)
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`요청 실패 (${response.status} ${response.statusText}) ${body.slice(0, 200)}`.trim());
  }
  return response.json();
}

/**
 * HTML 페이지를 요청하고 로그인 상태를 확인합니다.
 *
 * @param url 요청 URL
 * @param cookie 로그인 쿠키 문자열
 * @return 응답 HTML 문자열
 */
async function fetchText(url: string, cookie?: string): Promise<string> {
  const response = await fetch(url, {
    headers: buildHeaders("text/html,application/xhtml+xml", cookie),
    redirect: "follow"
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`요청 실패 (${response.status} ${response.statusText}) ${body.slice(0, 200)}`.trim());
  }

  const finalUrl = response.url;
  if (finalUrl.includes("accounts.goorm.io/login")) {
    throw new Error("로그인이 필요합니다. --cookie 또는 GOORM_COOKIE를 설정해 주세요.");
  }

  return response.text();
}

/**
 * 객체/배열 트리를 순회하며 콜백을 호출합니다.
 *
 * @param value 순회 시작 값
 * @param callback 각 노드에서 호출할 콜백
 * @param key 현재 노드 키
 * @param path 현재 노드 경로
 * @param depth 현재 순회 깊이
 * @param seen 순환 참조 방지용 방문 집합
 * @return 반환값 없음
 */
function walkObject(
  value: unknown,
  callback: (node: unknown, key: string | null, path: string[]) => void,
  key: string | null = null,
  path: string[] = [],
  depth = 0,
  seen = new Set<unknown>()
): void {
  if (depth > 8 || value == null) {
    return;
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return;
    }
    seen.add(value);
  }

  callback(value, key, path);

  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      walkObject(child, callback, String(index), [...path, String(index)], depth + 1, seen);
    });
    return;
  }

  if (isRecord(value)) {
    Object.entries(value).forEach(([childKey, childValue]) => {
      walkObject(childValue, callback, childKey, [...path, childKey], depth + 1, seen);
    });
  }
}

/**
 * 주어진 키 후보 중 첫 번째 문자열 값을 찾습니다.
 *
 * @param record 조회 대상 객체
 * @param keys 키 후보 목록
 * @return 찾은 문자열 값
 */
function getStringField(record: UnknownRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * 주어진 키 후보 중 첫 번째 숫자 값을 찾습니다.
 *
 * @param record 조회 대상 객체
 * @param keys 키 후보 목록
 * @return 찾은 숫자 값
 */
function getNumberField(record: UnknownRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0 && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
}

/**
 * 개별 강의 아이템의 완료 여부를 추정합니다.
 *
 * @param lesson 강의/콘텐츠 객체
 * @return 완료 여부
 */
function isLessonCompleted(lesson: UnknownRecord): boolean {
  const explicitKeys = [
    "isCompleted",
    "completed",
    "is_complete",
    "isDone",
    "done",
    "isLearned",
    "learned",
    "isAttended",
    "attended",
    "isFinished",
    "finished"
  ];

  for (const key of explicitKeys) {
    const value = lesson[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return value > 0;
    }
    if (typeof value === "string") {
      const normalized = value.toLowerCase();
      if (["done", "completed", "finish", "finished", "true", "pass"].includes(normalized)) {
        return true;
      }
      if (["todo", "not_started", "false", "incomplete"].includes(normalized)) {
        return false;
      }
    }
  }

  const percent = getNumberField(lesson, ["progressPercent", "progress", "completionRate"]);
  if (typeof percent === "number") {
    return percent >= 100;
  }

  return false;
}

/**
 * 챕터 객체에서 강의 배열을 추정해 찾습니다.
 *
 * @param chapter 챕터 객체
 * @return 강의 객체 배열
 */
function findLessonArray(chapter: UnknownRecord): UnknownRecord[] | undefined {
  const candidateKeys = ["lessons", "lessonData", "lessonList", "children", "items", "curriculumData"];
  for (const key of candidateKeys) {
    const value = chapter[key];
    if (!Array.isArray(value)) {
      continue;
    }
    const records = value.filter(isRecord);
    if (records.length > 0) {
      return records;
    }
  }
  return undefined;
}

/**
 * 챕터 객체를 섹션 진행 정보로 변환합니다.
 *
 * @param chapter 챕터 객체
 * @param order 섹션 순번
 * @return 섹션 진행 정보
 */
function sectionFromChapter(chapter: UnknownRecord, order: number): LectureSectionProgress {
  const title =
    getStringField(chapter, ["subject", "title", "name", "chapterTitle", "lessonTitle"]) ?? `Section ${order}`;

  const completedFromField = getNumberField(chapter, [
    "completedLessons",
    "completedLessonCount",
    "completeLessonCount",
    "doneCount",
    "completedCount"
  ]);

  const totalFromField = getNumberField(chapter, [
    "totalLessons",
    "totalLessonCount",
    "lessonCount",
    "totalContentsCount",
    "contentsCount"
  ]);

  const lessons = findLessonArray(chapter);
  const totalFromLessons = lessons?.length;
  const completedFromLessons = lessons?.filter((lesson) => isLessonCompleted(lesson)).length;

  const totalLessons = totalFromField ?? totalFromLessons ?? 0;
  const completedLessons = completedFromField ?? completedFromLessons ?? 0;

  return {
    order,
    title,
    completedLessons,
    totalLessons
  };
}

/**
 * 초기 상태에서 섹션 배열을 추출해 진행 정보 목록으로 변환합니다.
 *
 * @param state 강의 초기 상태 객체
 * @return 섹션 진행 정보 목록
 */
function extractSections(state: UnknownRecord): LectureSectionProgress[] {
  const arrays: Array<{path: string; items: UnknownRecord[]}> = [];

  walkObject(state, (node, key, path) => {
    if (!Array.isArray(node)) {
      return;
    }

    if (!key) {
      return;
    }

    const keyLower = key.toLowerCase();
    if (!/(curriculum|chapter|section|lesson|contents)/.test(keyLower)) {
      return;
    }

    const items = node.filter(isRecord);
    if (items.length === 0) {
      return;
    }

    arrays.push({
      path: path.join("."),
      items
    });
  });

  const prioritized = arrays
    .map((entry) => {
      const hasLessonArray = entry.items.some((item) => Boolean(findLessonArray(item)));
      const hasCountFields = entry.items.some((item) => {
        return (
          typeof getNumberField(item, ["completedLessonCount", "completedCount", "lessonCount", "totalLessonCount"]) ===
          "number"
        );
      });
      return {
        ...entry,
        score: (hasLessonArray ? 5 : 0) + (hasCountFields ? 3 : 0) + Math.min(entry.items.length, 5)
      };
    })
    .sort((a, b) => b.score - a.score);

  const top = prioritized[0];
  if (!top) {
    return [];
  }

  return top.items.map((item, index) => sectionFromChapter(item, index + 1));
}

/**
 * 마지막 수강 강의 제목 후보를 추출합니다.
 *
 * @param state 강의 초기 상태 객체
 * @return 마지막 수강 강의 제목
 */
function extractLastLessonTitle(state: UnknownRecord): string | undefined {
  const candidates: string[] = [];

  walkObject(state, (node, key) => {
    if (!key) {
      return;
    }

    const normalizedKey = key.toLowerCase();
    if (!/(last|recent|current)/.test(normalizedKey) || !/(lesson|lecture|class|contents)/.test(normalizedKey)) {
      return;
    }

    if (typeof node === "string" && node.trim().length > 0) {
      candidates.push(node.trim());
      return;
    }

    if (isRecord(node)) {
      const title = getStringField(node, ["subject", "title", "name", "lessonTitle"]);
      if (title) {
        candidates.push(title);
      }
    }
  });

  return candidates[0];
}

/**
 * 강의 기본 메타 정보를 초기 상태에서 추출합니다.
 *
 * @param state 강의 초기 상태 객체
 * @return 강의 제목/식별자 메타 정보
 */
function extractLectureMeta(state: UnknownRecord): {title: string; sequence?: number; index?: string; urlSlug?: string} {
  const topLectureData = isRecord(state.lectureData) ? state.lectureData : undefined;
  if (topLectureData) {
    return {
      title: getStringField(topLectureData, ["subject", "title", "name"]) ?? "Unknown Lecture",
      sequence: getNumberField(topLectureData, ["sequence"]),
      index: getStringField(topLectureData, ["index"]),
      urlSlug: getStringField(topLectureData, ["url_slug"])
    };
  }

  let fallback: {title: string; sequence?: number; index?: string; urlSlug?: string} | undefined;
  walkObject(state, (node, key) => {
    if (fallback || !isRecord(node) || key?.toLowerCase() !== "lecturedata") {
      return;
    }
    fallback = {
      title: getStringField(node, ["subject", "title", "name"]) ?? "Unknown Lecture",
      sequence: getNumberField(node, ["sequence"]),
      index: getStringField(node, ["index"]),
      urlSlug: getStringField(node, ["url_slug"])
    };
  });

  return fallback ?? {title: "Unknown Lecture"};
}

/**
 * 전체 진도 계산에 필요한 전역 카운트 값을 추출합니다.
 *
 * @param state 강의 초기 상태 객체
 * @return 완료 수/전체 수/진도율 후보
 */
function extractGlobalCounts(state: UnknownRecord): {completed?: number; total?: number; progressPercent?: number} {
  const completedKeys = [
    "completedLessons",
    "completedLessonCount",
    "completeLessonCount",
    "completedContentsCount",
    "doneCount"
  ];
  const totalKeys = ["totalLessons", "totalLessonCount", "lessonCount", "totalContentsCount", "contentsCount"];
  const percentKeys = ["progressPercent", "progressRate", "completionRate", "progress"];

  let completed: number | undefined;
  let total: number | undefined;
  let progressPercent: number | undefined;

  walkObject(state, (node) => {
    if (!isRecord(node)) {
      return;
    }
    if (typeof completed === "undefined") {
      completed = getNumberField(node, completedKeys);
    }
    if (typeof total === "undefined") {
      total = getNumberField(node, totalKeys);
    }
    if (typeof progressPercent === "undefined") {
      progressPercent = getNumberField(node, percentKeys);
    }
  });

  return {completed, total, progressPercent};
}

/**
 * 강의 진도 요약을 Markdown으로 변환합니다.
 *
 * @param summary 강의 진도 요약 정보
 * @return Markdown 문자열
 */
function toMarkdown(summary: LectureProgressSummary): string {
  const lines: string[] = [];

  lines.push(`# ${summary.title}`);
  lines.push("");
  lines.push(`- URL: ${summary.sourceUrl}`);
  if (typeof summary.lectureSequence === "number") {
    lines.push(`- Sequence: ${summary.lectureSequence}`);
  }
  if (summary.lectureIndex) {
    lines.push(`- Index: ${summary.lectureIndex}`);
  }
  if (summary.lastLesson) {
    lines.push(`- 마지막 수강 강의: ${summary.lastLesson}`);
  }
  if (typeof summary.completedLessons === "number" && typeof summary.totalLessons === "number") {
    lines.push(`- 진도: ${summary.completedLessons}/${summary.totalLessons} (${summary.progressPercent ?? 0}%)`);
  }

  lines.push("");
  lines.push("## 교육 과정");
  lines.push("");

  if (summary.sections.length === 0) {
    lines.push("_섹션 진도 데이터를 찾지 못했습니다._");
  } else {
    summary.sections.forEach((section) => {
      lines.push(
        `${String(section.order).padStart(2, "0")}. ${section.title} - ${section.completedLessons}/${section.totalLessons}`
      );
    });
  }

  return lines.join("\n").trimEnd() + "\n";
}

/**
 * learn URL을 절대 URL 형태로 정규화합니다.
 *
 * @param url 사용자가 입력한 learn URL
 * @return 절대 URL 문자열
 */
function normalizeLearnUrl(url: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }

  if (url.startsWith("/")) {
    return `${EDU_BASE_URL}${url}`;
  }

  return `${EDU_BASE_URL}/${url}`;
}

/**
 * 내 강의 목록에서 옵션에 맞는 강의를 선택합니다.
 *
 * @param list 내 강의 목록 배열
 * @param options 강의 선택 옵션
 * @return 선택된 강의 객체
 */
function pickLectureFromJoinedList(
  list: UnknownRecord[],
  options: LectureProgressDumpOptions
): UnknownRecord | undefined {
  if (typeof options.lectureSequence === "number") {
    return list.find((item) => getNumberField(item, ["sequence"]) === options.lectureSequence);
  }

  if (options.lectureIndex) {
    return list.find((item) => getStringField(item, ["index"]) === options.lectureIndex);
  }

  if (options.lectureTitleQuery) {
    const needle = options.lectureTitleQuery.toLowerCase();
    return list.find((item) => (getStringField(item, ["subject", "title", "name"]) ?? "").toLowerCase().includes(needle));
  }

  return list[0];
}

/**
 * 내 강의 목록 API를 순회해 대상 강의의 learn URL을 찾습니다.
 *
 * @param options 강의 선택 옵션
 * @return 대상 강의 learn URL
 */
async function resolveLearnUrlFromJoinedApi(options: LectureProgressDumpOptions): Promise<string> {
  let page = 1;
  while (page <= 20) {
    const response = (await fetchJson(`${EDU_BASE_URL}/api/lecture/joined?page=${page}`, options.cookie)) as UnknownRecord;
    const list = Array.isArray(response.list) ? response.list.filter(isRecord) : [];
    if (list.length === 0) {
      break;
    }

    const selected = pickLectureFromJoinedList(list, options);
    if (selected) {
      const sequence = getNumberField(selected, ["sequence"]);
      const slug = getStringField(selected, ["url_slug"]);
      if (!sequence) {
        throw new Error("선택된 강의의 sequence를 찾지 못했습니다.");
      }
      if (slug) {
        return `${EDU_BASE_URL}/learn/lecture/${sequence}/${encodeURIComponent(slug)}`;
      }
      return `${EDU_BASE_URL}/learn/lecture/${sequence}`;
    }

    page += 1;
  }

  throw new Error("내 강의 목록에서 대상 강의를 찾지 못했습니다. sequence/index/title 또는 learn URL을 지정해 주세요.");
}

/**
 * 초기 상태 객체를 최종 강의 진도 요약으로 변환합니다.
 *
 * @param state 강의 초기 상태 객체
 * @param sourceUrl 기준이 된 강의 페이지 URL
 * @return 강의 진도 요약 정보
 */
function buildSummaryFromState(state: UnknownRecord, sourceUrl: string): LectureProgressSummary {
  const lectureMeta = extractLectureMeta(state);
  const sections = extractSections(state);
  const lastLesson = extractLastLessonTitle(state);
  const globalCounts = extractGlobalCounts(state);

  const summedTotal = sections.reduce((acc, item) => acc + item.totalLessons, 0);
  const summedCompleted = sections.reduce((acc, item) => acc + item.completedLessons, 0);

  const totalLessons = globalCounts.total ?? (summedTotal > 0 ? summedTotal : undefined);
  const completedLessons = globalCounts.completed ?? (summedCompleted > 0 ? summedCompleted : undefined);
  const progressPercent =
    typeof globalCounts.progressPercent === "number"
      ? Number(globalCounts.progressPercent.toFixed(1))
      : typeof totalLessons === "number" && totalLessons > 0 && typeof completedLessons === "number"
      ? Number(((completedLessons / totalLessons) * 100).toFixed(1))
      : undefined;

  return {
    title: lectureMeta.title,
    lectureSequence: lectureMeta.sequence,
    lectureIndex: lectureMeta.index,
    sourceUrl,
    lastLesson,
    completedLessons,
    totalLessons,
    progressPercent,
    sections,
    fetchedAt: new Date().toISOString(),
    rawHints: {
      lectureMeta,
      globalCounts
    }
  };
}

/**
 * 외부에서 전달된 초기 상태 객체를 진도 요약으로 변환합니다.
 *
 * @param state 강의 초기 상태 객체
 * @param sourceUrl 기준 URL
 * @return 강의 진도 요약 정보
 */
export function extractLectureProgressFromState(state: Record<string, unknown>, sourceUrl: string): LectureProgressSummary {
  return buildSummaryFromState(state, sourceUrl);
}

/**
 * 강의 진도를 조회해 JSON/Markdown/원본 상태 파일로 저장합니다.
 *
 * @param options 강의 진도 덤프 실행 옵션
 * @return 강의 진도 요약 정보
 */
export async function dumpLectureProgress(options: LectureProgressDumpOptions): Promise<LectureProgressSummary> {
  await fs.mkdir(options.outDir, {recursive: true});

  const sourceUrl = options.learnUrl
    ? normalizeLearnUrl(options.learnUrl)
    : await resolveLearnUrlFromJoinedApi(options);

  const html = await fetchText(sourceUrl, options.cookie);
  const state = parseInitialStateFromHtml(html);
  const summary = extractLectureProgressFromState(state, sourceUrl);

  const summaryPath = path.join(options.outDir, "lecture-progress.json");
  const markdownPath = path.join(options.outDir, "lecture-progress.md");
  const statePath = path.join(options.outDir, "learn-initial-state.json");

  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  await fs.writeFile(markdownPath, toMarkdown(summary), "utf8");
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

  return summary;
}
