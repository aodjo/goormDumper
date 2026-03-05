import path from "node:path";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function sanitizeFileName(name: string): string {
  const collapsed = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return collapsed.slice(0, 80) || "untitled";
}

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

export function resolveOutDir(outDir: string): string {
  return path.isAbsolute(outDir) ? outDir : path.resolve(process.cwd(), outDir);
}
