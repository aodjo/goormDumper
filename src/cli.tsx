#!/usr/bin/env node
import React from "react";
import {render} from "ink";
import {App} from "./ui/App.js";

/**
 * CLI 엔트리포인트를 실행하고 Ink UI를 렌더링합니다.
 *
 * @return 실행 완료 시 resolve되는 Promise
 */
async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("인터랙티브 모드를 실행하려면 TTY 터미널이 필요합니다.");
    process.exit(1);
  }

  render(<App />);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`오류: ${message}`);
  process.exit(1);
});
