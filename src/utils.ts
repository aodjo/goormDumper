import path from "node:path";

/**
 * 지정한 밀리초만큼 비동기 대기합니다.
 *
 * @param ms 대기할 시간(밀리초)
 * @return 대기 완료 시 resolve되는 Promise
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 파일명으로 사용할 수 없는 문자를 제거하고 길이를 제한합니다.
 *
 * @param name 원본 문자열
 * @return 안전한 파일명 문자열
 */
export function sanitizeFileName(name: string): string {
  const collapsed = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return collapsed.slice(0, 80) || "untitled";
}

/**
 * 값을 양의 정수로 변환하고, 변환 실패 시 기본값을 반환합니다.
 *
 * @param value 변환 대상 값
 * @param fallback 변환 실패 시 사용할 기본값
 * @return 보정된 양의 정수
 */
export function ensurePositiveInt(value: unknown, fallback: number): number {
  const asNumber = Number(value);
  if (!Number.isFinite(asNumber)) {
    return fallback;
  }

  const int = Math.floor(asNumber);
  if (int <= 0) {
    return fallback;
  }

  return int;
}

/**
 * 출력 디렉터리를 절대경로로 정규화합니다.
 *
 * @param outDir 사용자가 입력한 경로
 * @return 절대경로로 변환된 출력 디렉터리
 */
export function resolveOutDir(outDir: string): string {
  return path.isAbsolute(outDir) ? outDir : path.resolve(process.cwd(), outDir);
}
