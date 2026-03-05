import fs from "node:fs/promises";
import {existsSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {chromium} from "playwright-core";

export type BrowserChoice = "auto" | "edge" | "chrome" | "brave";

interface CaptureCookieOptions {
  browser: BrowserChoice;
  outputPath?: string;
  timeoutMs?: number;
  onStatus?: (message: string) => void;
}

interface BrowserExecutable {
  browser: Exclude<BrowserChoice, "auto">;
  executablePath: string;
}

const BROWSER_PATHS: Record<Exclude<BrowserChoice, "auto">, string[]> = {
  edge: [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
  ],
  chrome: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe")
  ],
  brave: [
    "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    path.join(process.env.LOCALAPPDATA ?? "", "BraveSoftware\\Brave-Browser\\Application\\brave.exe")
  ]
};

function findBrowserExecutable(target: BrowserChoice): BrowserExecutable {
  const ordered =
    target === "auto"
      ? (["edge", "chrome", "brave"] as const)
      : ([target] as const);

  for (const browser of ordered) {
    const candidates = BROWSER_PATHS[browser];
    for (const candidate of candidates) {
      if (candidate && existsSync(candidate)) {
        return {
          browser,
          executablePath: candidate
        };
      }
    }
  }

  throw new Error(
    `브라우저 실행 파일을 찾지 못했습니다. --browser 옵션을 바꾸거나 설치 경로를 확인해 주세요. (target=${target})`
  );
}

function formatCookieHeader(cookies: Array<{name: string; value: string}>): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function checkLoginCookie(cookieHeader: string): Promise<boolean> {
  if (!cookieHeader) {
    return false;
  }

  try {
    const response = await fetch("https://level.goorm.io/api/lecture/joined?page=1", {
      headers: {
        "user-agent": "dumpgoorm-cli/1.0",
        accept: "application/json",
        cookie: cookieHeader
      }
    });

    return response.ok;
  } catch {
    return false;
  }
}

export async function captureGoormCookie(options: CaptureCookieOptions): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error("자동 쿠키 추출은 TTY 환경에서만 실행할 수 있습니다.");
  }

  const browserInfo = findBrowserExecutable(options.browser);
  const tempUserDataDir = path.join(os.tmpdir(), `dumpgoorm-auth-${Date.now()}`);
  let context:
    | Awaited<ReturnType<typeof chromium.launchPersistentContext>>
    | undefined;

  try {
    context = await chromium.launchPersistentContext(tempUserDataDir, {
      headless: false,
      executablePath: browserInfo.executablePath,
      viewport: null
    });

    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://level.goorm.io/", {waitUntil: "domcontentloaded"});

    options.onStatus?.(`브라우저 열림: ${browserInfo.browser}`);
    options.onStatus?.("브라우저에서 Goorm 로그인 중입니다...");

    const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const cookies = await context.cookies(["https://level.goorm.io", "https://edu.goorm.io"]);
      const cookieHeader = formatCookieHeader(cookies);
      if (await checkLoginCookie(cookieHeader)) {
        if (options.outputPath) {
          await fs.mkdir(path.dirname(options.outputPath), {recursive: true});
          await fs.writeFile(options.outputPath, cookieHeader, "utf8");
          options.onStatus?.(`쿠키 저장 완료: ${options.outputPath}`);
        }
        return cookieHeader;
      }

      options.onStatus?.("로그인 대기 중... (브라우저에서 로그인 후 잠시 기다려 주세요)");
      await new Promise((resolve) => {
        setTimeout(resolve, 3000);
      });
    }

    throw new Error("로그인 쿠키 확인 시간이 초과되었습니다. 다시 시도해 주세요.");
  } finally {
    if (context) {
      await context.close();
    }
    await fs.rm(tempUserDataDir, {recursive: true, force: true});
  }
}
