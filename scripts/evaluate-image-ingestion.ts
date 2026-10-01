// Evaluation harness for embedded-image ingestion.
//
// Usage:
//   npm run evaluate:images -- <document> [<document> ...] [options]
//
// Options:
//   --verbose                 Print one line per unique image (ID, status, size, location).
//   --live                    Also run the batched model pre-pass and print the findings.
//   --provider <id>           Provider for --live (default: Pi settings `defaultProvider`).
//   --model <id>              Model for --live (default: Pi settings `defaultModel`).
//   --batch-size <n>          Images per model call for --live (default: IMAGE_ANALYSIS_BATCH_SIZE).
//   --ground-truth <file>     JSON with expected values per document (see scripts/examples/).
//   --pi-sdk <module path>    Pi SDK entry (dist/index.js) providing ModelRuntime + ModelRegistry;
//                             default: the local dev dependency, then the installed `pi` binary.
//   --keep                    Keep the temporary extraction directory.
//
// Fixture documents are read in place and never copied into the repository;
// staged files go to a temporary directory that is removed afterwards.

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { extractToTempFile } from "../src/extract/service.ts";
import { createModelImageAnalysisRepository } from "../src/image-analysis/repository.ts";
import {
  countImageStatuses,
  renderImageFindings,
  runImagePrepass,
} from "../src/image-analysis/prepass.ts";
import { summarizeDocumentImages } from "../src/image-analysis/completeness.ts";
import { err, ok, IMAGE_STATUSES, type Result, type StagedImage } from "../src/types.ts";

interface Options {
  readonly documents: readonly string[];
  readonly verbose: boolean;
  readonly live: boolean;
  readonly keep: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly batchSize?: number;
  readonly groundTruthPath?: string;
  readonly piSdkPath?: string;
}

/** Expected value: a string, or alternatives of which one must appear. */
type ExpectedValue = string | readonly string[];

interface GroundTruth {
  readonly documents: Readonly<Record<string, { readonly expectedValues: readonly ExpectedValue[] }>>;
}

interface PiSdkDto {
  readonly ModelRuntime: { create(options?: Record<string, unknown>): Promise<unknown> };
  readonly ModelRegistry: new (runtime: unknown) => { find(provider: string, modelId: string): unknown };
}

const USAGE = "Usage: npm run evaluate:images -- <document> [...] [--verbose] [--live] [--provider <id>] [--model <id>] [--batch-size <n>] [--ground-truth <file>] [--pi-sdk <path>] [--keep]";

async function main(): Promise<number> {
  const parsed = parseArguments(process.argv.slice(2));
  if (!parsed.success) {
    console.error(parsed.error.message);
    console.error(USAGE);
    return 2;
  }
  const options = parsed.data;
  const groundTruth = options.groundTruthPath === undefined ? undefined : await loadGroundTruth(options.groundTruthPath);
  if (groundTruth !== undefined && !groundTruth.success) {
    console.error(groundTruth.error.message);
    return 2;
  }
  const workRoot = await mkdtemp(join(tmpdir(), "okf-image-evaluation-"));
  let failures = 0;
  try {
    for (const [index, documentPath] of options.documents.entries()) {
      const absolutePath = resolve(documentPath);
      const relativePath = `document-${index + 1}/${basename(absolutePath)}`;
      console.log(`\n=== ${basename(absolutePath)} ===`);
      const extracted = await extractToTempFile(workRoot, relativePath, absolutePath);
      if (!extracted.success) {
        console.log(`  extraction failed (${extracted.error.cause ?? "unknown"}): ${extracted.error.message}`);
        failures++;
        continue;
      }
      const statistics = extracted.data.imageStatistics;
      console.log(`  images found (occurrences):        ${statistics.occurrences}`);
      console.log(`  associated with context:           ${statistics.occurrencesWithContext}`);
      console.log(`  unique after deduplication:        ${statistics.unique} (deduplicated: ${statistics.duplicates})`);
      console.log(`  skipped as tiny (decorative):      ${statistics.tiny}`);
      console.log(`  flagged broken:                    ${statistics.broken}`);
      console.log(`  staged for analysis:               ${statistics.staged}`);
      console.log(`  dropped by limits/errors:          ${statistics.dropped}`);
      console.log(`  warnings:                          ${extracted.data.warnings.length}`);
      for (const warning of extracted.data.warnings) console.log(`    ! ${warning}`);
      if (options.verbose) printImages(extracted.data.embeddedImages);

      if (!options.live) continue;
      const repository = await createLiveRepository(options);
      const document = { relativePath: basename(absolutePath), images: extracted.data.embeddedImages };
      const prepass = await runImagePrepass([document], repository, {
        ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
        onProgress: (progress) => process.stderr.write(`  batch ${progress.completedBatches}/${progress.totalBatches}\r`),
      });
      process.stderr.write("\n");
      const analyzed = prepass.documents[0] ?? document;
      console.log(`  pre-pass: ${prepass.modelCalls} model call(s) to ${prepass.modelLabel ?? "(unavailable)"}; tokens ${prepass.usage.inputTokens} in / ${prepass.usage.outputTokens} out${prepass.usage.cost > 0 ? `; cost ${prepass.usage.cost.toFixed(4)}` : ""}`);
      for (const warning of prepass.warnings) console.log(`    ! ${warning}`);
      const counts = countImageStatuses(analyzed.images);
      console.log(`  statuses: ${IMAGE_STATUSES.map((status) => `${status} ${counts[status]}`).join(", ")}`);
      console.log(`  log line: ${summarizeDocumentImages(analyzed)}`);
      console.log("  --- findings file ---");
      console.log(renderImageFindings(analyzed, prepass.modelLabel).split("\n").map((line) => `  | ${line}`).join("\n"));
      if (groundTruth?.success === true) {
        const expected = groundTruth.data.documents[basename(absolutePath)];
        if (expected === undefined) {
          console.log("  ground truth: no entry for this document");
        } else {
          failures += checkGroundTruth(analyzed.images, expected.expectedValues);
        }
      }
    }
  } finally {
    if (options.keep) console.log(`\nKept extraction directory: ${workRoot}`);
    else await rm(workRoot, { recursive: true, force: true });
  }
  return failures === 0 ? 0 : 1;
}

function printImages(images: readonly StagedImage[]): void {
  for (const image of images) {
    const size = image.width === undefined ? "?" : `${image.width}×${image.height}`;
    const location = image.occurrences.map((occurrence) => occurrence.location ?? "unknown").join(" | ");
    const reason = image.statusReason === undefined ? "" : ` (${image.statusReason})`;
    console.log(`    ${image.id} ${image.status}${reason} ${size} ${image.byteLength} B ×${image.occurrences.length} — ${location.slice(0, 120)}`);
  }
}

/** Returns the number of missing expected values (0 = pass). */
function checkGroundTruth(images: readonly StagedImage[], expectedValues: readonly ExpectedValue[]): number {
  const haystack = normalizeForMatch(images
    .map((image) => image.finding === undefined ? "" : [image.finding.description, ...image.finding.legibleValues].join(" \n "))
    .join(" \n "));
  let missing = 0;
  for (const expected of expectedValues) {
    const alternatives = typeof expected === "string" ? [expected] : expected;
    const found = alternatives.some((alternative) => haystack.includes(normalizeForMatch(alternative)));
    if (!found) missing++;
    console.log(`  ground truth ${found ? "✓" : "✗"} ${alternatives.join(" | ")}`);
  }
  console.log(`  ground truth: ${expectedValues.length - missing}/${expectedValues.length} expected values found in findings`);
  return missing;
}

/** Lowercase, decimal comma -> dot, whitespace removed (so "120 ms" matches "120ms"). */
function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/(\d),(\d)/g, "$1.$2").replace(/\s+/g, "");
}

let cachedRepository: ReturnType<typeof createModelImageAnalysisRepository> | undefined;

async function createLiveRepository(options: Options): Promise<ReturnType<typeof createModelImageAnalysisRepository>> {
  if (cachedRepository !== undefined) return cachedRepository;
  const settings = await readPiSettings();
  const provider = options.provider ?? settings.provider;
  const modelId = options.model ?? settings.model;
  if (provider === undefined || modelId === undefined) {
    cachedRepository = err("No --provider/--model given and no Pi default model configured.");
    return cachedRepository;
  }
  const sdk = await loadPiSdk(options.piSdkPath);
  if (!sdk.success) {
    cachedRepository = sdk;
    return cachedRepository;
  }
  const runtime = await sdk.data.ModelRuntime.create();
  const registry = new sdk.data.ModelRegistry(runtime);
  const model = registry.find(provider, modelId);
  cachedRepository = model === undefined
    ? err(`Model ${provider}/${modelId} was not found in the Pi model registry.`)
    : createModelImageAnalysisRepository(registry, model);
  return cachedRepository;
}

async function loadPiSdk(explicitPath: string | undefined): Promise<Result<PiSdkDto>> {
  const candidates = explicitPath === undefined
    ? ["@earendil-works/pi-coding-agent", ...installedPiSdkCandidates()]
    : [explicitPath];
  const problems: string[] = [];
  for (const candidate of candidates) {
    try {
      const specifier = candidate.startsWith("/") ? pathToFileURL(candidate).href : candidate;
      const module: unknown = await import(specifier);
      if (isPiSdk(module)) return ok(module);
      problems.push(`${candidate}: no ModelRuntime/ModelRegistry with nested completion support`);
    } catch (error) {
      problems.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return err(`Could not load a Pi SDK with ModelRuntime (${problems.join("; ")}). Pass --pi-sdk <path/to/pi-coding-agent/dist/index.js>.`);
}

function isPiSdk(module: unknown): module is PiSdkDto {
  if (typeof module !== "object" || module === null) return false;
  const candidate = module as { ModelRuntime?: { create?: unknown }; ModelRegistry?: { prototype?: { complete?: unknown } } };
  return typeof candidate.ModelRuntime?.create === "function"
    && typeof candidate.ModelRegistry?.prototype?.complete === "function";
}

/** Locate the SDK next to the installed `pi` binary (npm global or Homebrew layout). */
function installedPiSdkCandidates(): string[] {
  let binaries: string[];
  try {
    // `-a`: `npm run` puts the local node_modules/.bin first on PATH.
    binaries = execFileSync("which", ["-a", "pi"], { encoding: "utf8" }).split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  } catch {
    return [];
  }
  const candidates: string[] = [];
  for (const binary of binaries) {
    let directory = dirname(realpathSync(binary));
    for (let depth = 0; depth < 6; depth++) {
      for (const relative of [
        "package.json",
        "lib/node_modules/@earendil-works/pi-coding-agent/package.json",
        "libexec/lib/node_modules/@earendil-works/pi-coding-agent/package.json",
      ]) {
        const packageJson = join(directory, relative);
        if (existsSync(packageJson) && existsSync(join(dirname(packageJson), "dist/index.js"))) {
          candidates.push(join(dirname(packageJson), "dist/index.js"));
        }
      }
      directory = dirname(directory);
    }
  }
  return [...new Set(candidates)];
}

async function readPiSettings(): Promise<{ readonly provider?: string; readonly model?: string }> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(homedir(), ".pi", "agent", "settings.json"), "utf8"));
    if (typeof raw !== "object" || raw === null) return {};
    const settings = raw as { defaultProvider?: unknown; defaultModel?: unknown };
    return {
      ...(typeof settings.defaultProvider === "string" ? { provider: settings.defaultProvider } : {}),
      ...(typeof settings.defaultModel === "string" ? { model: settings.defaultModel } : {}),
    };
  } catch {
    return {};
  }
}

async function loadGroundTruth(path: string): Promise<Result<GroundTruth>> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof raw !== "object" || raw === null || typeof (raw as { documents?: unknown }).documents !== "object") {
      return err(`Ground truth ${path} must be an object with a "documents" map.`);
    }
    return ok(raw as GroundTruth);
  } catch (error) {
    return err(`Could not read ground truth ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseArguments(argumentsList: readonly string[]): Result<Options> {
  const documents: string[] = [];
  let verbose = false;
  let live = false;
  let keep = false;
  let provider: string | undefined;
  let model: string | undefined;
  let batchSize: number | undefined;
  let groundTruthPath: string | undefined;
  let piSdkPath: string | undefined;
  for (let index = 0; index < argumentsList.length; index++) {
    const argument = argumentsList[index] ?? "";
    const value = (): string | undefined => argumentsList[++index];
    switch (argument) {
      case "--verbose": verbose = true; break;
      case "--live": live = true; break;
      case "--keep": keep = true; break;
      case "--provider": provider = value(); break;
      case "--model": model = value(); break;
      case "--ground-truth": groundTruthPath = value(); break;
      case "--pi-sdk": piSdkPath = value(); break;
      case "--batch-size": {
        const parsed = Number(value());
        if (!Number.isInteger(parsed) || parsed < 1) return err("--batch-size must be a positive integer.");
        batchSize = parsed;
        break;
      }
      default:
        if (argument.startsWith("--")) return err(`Unknown option ${argument}.`);
        documents.push(argument);
    }
  }
  if (documents.length === 0) return err("No documents given.");
  if (groundTruthPath !== undefined && !live) return err("--ground-truth requires --live.");
  return ok({
    documents,
    verbose,
    live,
    keep,
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(batchSize === undefined ? {} : { batchSize }),
    ...(groundTruthPath === undefined ? {} : { groundTruthPath }),
    ...(piSdkPath === undefined ? {} : { piSdkPath }),
  });
}

process.exitCode = await main();
