// Warning aggregation shared by extraction, image analysis, and finalize.
// Extractors may report the same limitation once per image; the log and the
// summary widget must show it once, with a repeat count, instead of N times.

/**
 * Collapse repeated warnings (compared after whitespace normalization) into a
 * single line suffixed with `(×N)`, preserving first-occurrence order. Lines
 * that already carry a `(×N)` suffix are merged by adding their counts, so
 * aggregating twice is idempotent.
 */
export function aggregateWarnings(warnings: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const warning of warnings) {
    const { text, count } = splitRepeatCount(warning.replace(/\s+/g, " ").trim());
    if (text.length === 0) continue;
    counts.set(text, (counts.get(text) ?? 0) + count);
  }
  return [...counts.entries()].map(([text, count]) => (count > 1 ? `${text} (×${count})` : text));
}

interface RepeatCountedWarning {
  readonly text: string;
  readonly count: number;
}

function splitRepeatCount(warning: string): RepeatCountedWarning {
  const match = warning.match(/^(.*\S)\s+\(×(\d+)\)$/u);
  if (match === null) return { text: warning, count: 1 };
  return { text: match[1] ?? warning, count: Number(match[2]) };
}
