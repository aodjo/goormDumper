import path from "node:path";
import React, {useEffect, useMemo, useState} from "react";
import {Box, Newline, Text, useApp, useInput} from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import {captureGoormCookie} from "../auth-cookie.js";
import type {BrowserChoice} from "../auth-cookie.js";
import {dumpGoormProblems} from "../dump.js";
import {dumpLectureProgress} from "../lecture-progress.js";
import type {DumpConfig, DumpProgressEvent, DumpSummary, LectureProgressSummary} from "../types.js";
import {ensurePositiveInt, resolveOutDir} from "../utils.js";

type DumpMode = "problem" | "lecture";
type Phase = "mode" | "config" | "running" | "done" | "error";
type ProblemField = "pages" | "limit" | "outDir" | "delayMs";
type LectureField = "outDir" | "learnUrl" | "lectureTitleQuery" | "browser";
type ConfigField = ProblemField | LectureField;

type RunResult =
  | {kind: "problem"; summary: DumpSummary}
  | {kind: "lecture"; summary: LectureProgressSummary; outDir: string};

const BROWSER_ORDER: BrowserChoice[] = ["auto", "edge", "chrome", "brave"];

function modeLabel(mode: DumpMode): string {
  return mode === "problem" ? "문제 덤프" : "강좌 진도 덤프";
}

function browserLabel(browser: BrowserChoice): string {
  if (browser === "auto") {
    return "auto (edge > chrome > brave)";
  }

  return browser;
}

function formatProblemEvent(event: DumpProgressEvent): string {
  switch (event.type) {
    case "page":
      return `목록 조회 ${event.page}/${event.pages} 페이지`;
    case "quiz":
      return `상세 조회 ${event.current}/${event.total}: ${event.title}`;
    case "saved":
      return `저장 완료: ${event.path}`;
    case "warning":
      return `경고: ${event.message}`;
    case "error":
      return `오류: ${event.message}`;
    default:
      return "진행 중";
  }
}

function cycleBrowser(current: BrowserChoice, direction: 1 | -1): BrowserChoice {
  const index = BROWSER_ORDER.indexOf(current);
  if (index < 0) {
    return "auto";
  }

  const nextIndex = (index + direction + BROWSER_ORDER.length) % BROWSER_ORDER.length;
  return BROWSER_ORDER[nextIndex];
}

function relativePath(absolutePath: string): string {
  return path.relative(process.cwd(), absolutePath) || ".";
}

function keysByMode(mode: DumpMode): ConfigField[] {
  if (mode === "problem") {
    return ["pages", "limit", "outDir", "delayMs"];
  }

  return ["outDir", "learnUrl", "lectureTitleQuery", "browser"];
}

export function App(): React.JSX.Element {
  const {exit} = useApp();

  const [phase, setPhase] = useState<Phase>("mode");
  const [mode, setMode] = useState<DumpMode>("problem");
  const [focusedFieldIndex, setFocusedFieldIndex] = useState(0);
  const [runStarted, setRunStarted] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [result, setResult] = useState<RunResult | null>(null);

  const [pagesInput, setPagesInput] = useState("1");
  const [limitInput, setLimitInput] = useState("20");
  const [problemOutDirInput, setProblemOutDirInput] = useState("./dumps");
  const [delayMsInput, setDelayMsInput] = useState("150");

  const [lectureOutDirInput, setLectureOutDirInput] = useState("./lecture-progress");
  const [learnUrlInput, setLearnUrlInput] = useState("");
  const [lectureTitleQueryInput, setLectureTitleQueryInput] = useState("");
  const [browser, setBrowser] = useState<BrowserChoice>("auto");

  const modeItems = useMemo<Array<{label: string; value: DumpMode}>>(() => {
    return [
      {label: "문제 덤프", value: "problem"},
      {label: "강좌 진도 덤프", value: "lecture"}
    ];
  }, []);

  const configFields = useMemo<ConfigField[]>(() => keysByMode(mode), [mode]);
  const focusedField = configFields[focusedFieldIndex] ?? configFields[0];

  const problemConfig = useMemo<DumpConfig>(() => {
    return {
      pages: ensurePositiveInt(pagesInput, 1),
      limit: ensurePositiveInt(limitInput, 20),
      outDir: resolveOutDir(problemOutDirInput || "./dumps"),
      delayMs: ensurePositiveInt(delayMsInput, 150)
    };
  }, [delayMsInput, limitInput, pagesInput, problemOutDirInput]);

  const lectureConfig = useMemo(() => {
    const trimmedLearnUrl = learnUrlInput.trim();
    const trimmedLectureTitleQuery = lectureTitleQueryInput.trim();

    return {
      outDir: resolveOutDir(lectureOutDirInput || "./lecture-progress"),
      learnUrl: trimmedLearnUrl.length > 0 ? trimmedLearnUrl : undefined,
      lectureTitleQuery: trimmedLectureTitleQuery.length > 0 ? trimmedLectureTitleQuery : undefined,
      browser
    };
  }, [browser, learnUrlInput, lectureOutDirInput, lectureTitleQueryInput]);

  const appendLog = (line: string): void => {
    setLogs((prev) => [...prev, line].slice(-14));
  };

  const resetRunState = (): void => {
    setRunStarted(false);
    setLogs([]);
    setErrorMessage("");
    setResult(null);
  };

  const goToModeSelection = (): void => {
    resetRunState();
    setFocusedFieldIndex(0);
    setPhase("mode");
  };

  const startRun = (): void => {
    resetRunState();
    setPhase("running");
  };

  const moveFieldFocus = (direction: 1 | -1): void => {
    setFocusedFieldIndex((prev) => (prev + direction + configFields.length) % configFields.length);
  };

  const advanceField = (): void => {
    if (focusedFieldIndex >= configFields.length - 1) {
      startRun();
      return;
    }

    setFocusedFieldIndex((prev) => prev + 1);
  };

  useEffect(() => {
    if (focusedFieldIndex < configFields.length) {
      return;
    }

    setFocusedFieldIndex(0);
  }, [configFields, focusedFieldIndex]);

  useEffect(() => {
    if (phase !== "running" || runStarted) {
      return;
    }

    let active = true;
    setRunStarted(true);

    const fail = (error: unknown): void => {
      if (!active) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      setErrorMessage(message);
      setPhase("error");
    };

    if (mode === "problem") {
      appendLog(
        `문제 덤프 시작: pages=${problemConfig.pages}, limit=${problemConfig.limit}, out=${problemConfig.outDir}`
      );

      dumpGoormProblems(problemConfig, (event) => {
        if (!active) {
          return;
        }

        appendLog(formatProblemEvent(event));
      })
        .then((summary) => {
          if (!active) {
            return;
          }

          setResult({kind: "problem", summary});
          setPhase("done");
        })
        .catch((error: unknown) => {
          fail(error);
        });

      return () => {
        active = false;
      };
    }

    appendLog(`브라우저 쿠키 추출 시작: ${browserLabel(lectureConfig.browser)}`);
    appendLog("브라우저에서 로그인하면 자동으로 진행됩니다.");

    captureGoormCookie({
      browser: lectureConfig.browser,
      onStatus: (message) => {
        if (!active) {
          return;
        }
        appendLog(message);
      }
    })
      .then((cookie) => {
        if (!active) {
          return undefined;
        }

        appendLog("강좌 진도 조회 시작...");
        return dumpLectureProgress({
          outDir: lectureConfig.outDir,
          cookie,
          learnUrl: lectureConfig.learnUrl,
          lectureTitleQuery: lectureConfig.lectureTitleQuery
        });
      })
      .then((summary) => {
        if (!active || !summary) {
          return;
        }

        setResult({kind: "lecture", summary, outDir: lectureConfig.outDir});
        setPhase("done");
      })
      .catch((error: unknown) => {
        fail(error);
      });

    return () => {
      active = false;
    };
  }, [lectureConfig, mode, phase, problemConfig, runStarted]);

  useInput((input, key) => {
    if (phase === "mode") {
      if (key.escape || input.toLowerCase() === "q") {
        exit();
      }
      return;
    }

    if (phase === "config") {
      if (key.escape) {
        goToModeSelection();
        return;
      }

      if (key.tab && key.shift) {
        moveFieldFocus(-1);
        return;
      }

      if (key.tab || key.downArrow) {
        moveFieldFocus(1);
        return;
      }

      if (key.upArrow) {
        moveFieldFocus(-1);
        return;
      }

      if (focusedField === "browser" && (key.leftArrow || key.rightArrow)) {
        setBrowser((prev) => cycleBrowser(prev, key.rightArrow ? 1 : -1));
        return;
      }

      if (key.return) {
        advanceField();
        return;
      }

      if (input.toLowerCase() === "s" && key.ctrl) {
        startRun();
      }

      return;
    }

    if (phase === "running") {
      return;
    }

    if (phase === "done" || phase === "error") {
      if (input.toLowerCase() === "r") {
        goToModeSelection();
        return;
      }

      if (key.escape || key.return || input.toLowerCase() === "q") {
        exit();
      }
    }
  });

  const renderProblemField = (field: ProblemField): React.JSX.Element => {
    const active = focusedField === field;
    const marker = active ? ">" : " ";
    const color = active ? "yellowBright" : undefined;

    if (field === "pages") {
      return (
        <Box key={field}>
          <Text color={color}>{marker} Pages: </Text>
          {active ? <TextInput value={pagesInput} onChange={setPagesInput} focus /> : <Text>{pagesInput}</Text>}
        </Box>
      );
    }

    if (field === "limit") {
      return (
        <Box key={field}>
          <Text color={color}>{marker} Limit: </Text>
          {active ? <TextInput value={limitInput} onChange={setLimitInput} focus /> : <Text>{limitInput}</Text>}
        </Box>
      );
    }

    if (field === "outDir") {
      return (
        <Box key={field}>
          <Text color={color}>{marker} Output Dir: </Text>
          {active ? (
            <TextInput value={problemOutDirInput} onChange={setProblemOutDirInput} focus />
          ) : (
            <Text>{problemOutDirInput}</Text>
          )}
        </Box>
      );
    }

    return (
      <Box key={field}>
        <Text color={color}>{marker} Delay (ms): </Text>
        {active ? <TextInput value={delayMsInput} onChange={setDelayMsInput} focus /> : <Text>{delayMsInput}</Text>}
      </Box>
    );
  };

  const renderLectureField = (field: LectureField): React.JSX.Element => {
    const active = focusedField === field;
    const marker = active ? ">" : " ";
    const color = active ? "yellowBright" : undefined;

    if (field === "outDir") {
      return (
        <Box key={field}>
          <Text color={color}>{marker} Output Dir: </Text>
          {active ? (
            <TextInput value={lectureOutDirInput} onChange={setLectureOutDirInput} focus />
          ) : (
            <Text>{lectureOutDirInput}</Text>
          )}
        </Box>
      );
    }

    if (field === "learnUrl") {
      return (
        <Box key={field}>
          <Text color={color}>{marker} Learn URL (optional): </Text>
          {active ? <TextInput value={learnUrlInput} onChange={setLearnUrlInput} focus /> : <Text>{learnUrlInput || "-"}</Text>}
        </Box>
      );
    }

    if (field === "lectureTitleQuery") {
      return (
        <Box key={field}>
          <Text color={color}>{marker} Lecture Query (optional): </Text>
          {active ? (
            <TextInput value={lectureTitleQueryInput} onChange={setLectureTitleQueryInput} focus />
          ) : (
            <Text>{lectureTitleQueryInput || "-"}</Text>
          )}
        </Box>
      );
    }

    return (
      <Box key={field}>
        <Text color={color}>{marker} Browser: </Text>
        <Text>{browserLabel(browser)}</Text>
      </Box>
    );
  };

  if (phase === "mode") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyanBright">dumpgoorm</Text>
        <Text>덤프할 대상을 선택하세요.</Text>
        <Newline />
        <Box borderStyle="round" borderColor="cyan" paddingX={1} paddingY={0} flexDirection="column">
          <SelectInput<DumpMode>
            items={modeItems}
            onSelect={(item) => {
              setMode(item.value);
              setFocusedFieldIndex(0);
              setPhase("config");
            }}
          />
        </Box>
        <Newline />
        <Text dimColor>사용키: ↑/↓ 선택, Enter 설정, Esc 종료</Text>
      </Box>
    );
  }

  if (phase === "config") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyanBright">설정 - {modeLabel(mode)}</Text>
        <Text dimColor>Esc: 모드 선택으로 돌아가기</Text>
        <Newline />
        <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
          {mode === "problem"
            ? configFields.map((field) => renderProblemField(field as ProblemField))
            : configFields.map((field) => renderLectureField(field as LectureField))}
        </Box>
        <Newline />

        <Text dimColor>사용키: ↑/↓ 이동, Enter 다음/실행, Ctrl+S 실행</Text>
        {mode === "lecture" && <Text dimColor>브라우저 항목에서 ←/→ 로 browser 선택</Text>}
      </Box>
    );
  }

  if (phase === "running") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyanBright">
          <Spinner type="dots" /> {mode === "problem" ? "문제 덤프 실행 중" : "강좌 진도 덤프 실행 중"}
        </Text>
        <Text dimColor>완료까지 기다려 주세요.</Text>
        <Newline />
        <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
          {logs.map((line, index) => (
            <Text key={`${index}-${line}`}>{line}</Text>
          ))}
        </Box>
      </Box>
    );
  }

  if (phase === "error") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="redBright">실패: {errorMessage}</Text>
        <Text dimColor>Esc 종료, r 재시작</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Text color="greenBright">완료</Text>
      <Newline />
      <Box borderStyle="round" borderColor="green" paddingX={1} flexDirection="column">
        {result?.kind === "problem" && (
          <>
            <Text>
              listed={result.summary.listed}, dumped={result.summary.dumped}, failed={result.summary.failed}
            </Text>
            <Text>output={result.summary.outputDir}</Text>
          </>
        )}
        {result?.kind === "lecture" && (
          <>
            <Text>강좌: {result.summary.title}</Text>
            {result.summary.lastLesson && <Text>마지막 수강 강의: {result.summary.lastLesson}</Text>}
            {typeof result.summary.completedLessons === "number" && typeof result.summary.totalLessons === "number" && (
              <Text>
                진도: {result.summary.completedLessons}/{result.summary.totalLessons} ({result.summary.progressPercent ?? 0}%)
              </Text>
            )}
            <Text>섹션 수: {result.summary.sections.length}</Text>
            <Text>output={result.outDir}</Text>
          </>
        )}
      </Box>
      <Newline />
      <Text dimColor>Esc 종료, r 재시작</Text>
    </Box>
  );
}
