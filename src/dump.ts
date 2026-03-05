import fs from "node:fs/promises";
import path from "node:path";
import {fetchQuizDetailFromExamPage, fetchQuizPage} from "./goorm.js";
import type {DumpConfig, DumpProgressEvent, DumpSummary, QuizListEntry} from "./types.js";
import {sanitizeFileName, sleep} from "./utils.js";

interface ProblemRecord {
  list: QuizListEntry;
  detail: Awaited<ReturnType<typeof fetchQuizDetailFromExamPage>>;
}

function toMarkdown(record: ProblemRecord): string {
  const {list, detail} = record;
  const sections: string[] = [];

  sections.push(`# ${detail.title}`);
  sections.push("");
  sections.push(`- Index: \`${detail.index}\``);
  if (typeof list.difficulty === "number") {
    sections.push(`- Difficulty: ${list.difficulty}`);
  }
  sections.push(`- URL: ${detail.sourceUrl}`);
  if (detail.answerLanguages.length > 0) {
    sections.push(`- Languages: ${detail.answerLanguages.join(", ")}`);
  }

  sections.push("");
  sections.push("## Problem");
  sections.push("");
  sections.push(detail.contentsMarkdown || detail.metaDataText || "_No content_");

  if (detail.inputExamples.length > 0) {
    sections.push("");
    sections.push("## Input Example");
    sections.push("");
    detail.inputExamples.forEach((example, index) => {
      sections.push(`### #${index + 1}`);
      sections.push("```text");
      sections.push(example.trimEnd());
      sections.push("```");
      sections.push("");
    });
  }

  if (detail.outputExamples.length > 0) {
    sections.push("## Output Example");
    sections.push("");
    detail.outputExamples.forEach((example, index) => {
      sections.push(`### #${index + 1}`);
      sections.push("```text");
      sections.push(example.trimEnd());
      sections.push("```");
      sections.push("");
    });
  }

  return sections.join("\n").trimEnd() + "\n";
}

export async function dumpGoormProblems(
  config: DumpConfig,
  onProgress?: (event: DumpProgressEvent) => void
): Promise<DumpSummary> {
  await fs.mkdir(config.outDir, {recursive: true});

  const listed: QuizListEntry[] = [];
  let totalFromApi = 0;

  for (let page = 1; page <= config.pages; page += 1) {
    onProgress?.({type: "page", page, pages: config.pages});
    const response = await fetchQuizPage(page, config.limit, config.cookie);
    totalFromApi = Math.max(totalFromApi, response.total);
    listed.push(...response.data);
  }

  const uniqueMap = new Map<string, QuizListEntry>();
  listed.forEach((item) => {
    if (!uniqueMap.has(item.index)) {
      uniqueMap.set(item.index, item);
    }
  });

  const targets = Array.from(uniqueMap.values());
  const failures: DumpSummary["failures"] = [];
  let dumped = 0;

  for (let i = 0; i < targets.length; i += 1) {
    const item = targets[i];
    onProgress?.({type: "quiz", current: i + 1, total: targets.length, title: item.title});

    try {
      const detail = await fetchQuizDetailFromExamPage(item, config.cookie);
      const fileSafeTitle = sanitizeFileName(detail.title);
      const directoryName = `${String(i + 1).padStart(4, "0")}-${fileSafeTitle}-${detail.index}`;
      const directoryPath = path.join(config.outDir, directoryName);
      await fs.mkdir(directoryPath, {recursive: true});

      const record: ProblemRecord = {
        list: item,
        detail
      };

      const jsonPath = path.join(directoryPath, "problem.json");
      const markdownPath = path.join(directoryPath, "problem.md");
      await fs.writeFile(jsonPath, JSON.stringify(record, null, 2), "utf8");
      await fs.writeFile(markdownPath, toMarkdown(record), "utf8");

      dumped += 1;
      onProgress?.({type: "saved", path: directoryPath});
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push({
        index: item.index,
        title: item.title,
        reason
      });
      onProgress?.({type: "error", message: `[${item.index}] ${reason}`});
    }

    if (config.delayMs > 0 && i < targets.length - 1) {
      await sleep(config.delayMs);
    }
  }

  const summary: DumpSummary = {
    totalFromApi,
    requestedPages: config.pages,
    listed: targets.length,
    dumped,
    failed: failures.length,
    outputDir: config.outDir,
    failures
  };

  const summaryPath = path.join(config.outDir, "dump-summary.json");
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");

  return summary;
}
