// Barrel re-export of the focused wiki/ modules. The implementations live in
// ./wiki/paths.ts, ./wiki/concepts.ts, ./wiki/index-log.ts, and
// ./wiki/retrieval.ts; this file just keeps the `./wiki.ts` import surface
// stable for update.ts, query.ts, classifier.ts, and prompts.ts.

export {
  wikiPaths,
  conceptIdFromRelativePath,
  isConceptFile,
  relativePosix,
  type WikiPaths,
} from "./wiki/paths.ts";

export {
  loadConcept,
  loadAllConcepts,
  snapshotWiki,
  diffSnapshots,
  type WikiDiff,
} from "./wiki/concepts.ts";

export {
  OKF_VERSION,
  computeIndexDirs,
  generateDirIndexMd,
  generateRootIndexMd,
  writeAllIndexMd,
  appendLogMd,
} from "./wiki/index-log.ts";

export {
  retrieveConcepts,
  defaultRetriever,
  TermFrequencyRetriever,
  TfIdfRetriever,
  renderConceptForPrompt,
  tokenize,
  renderWikiTree,
  displayTitle,
  buildStructurePreview,
  type Retriever,
  type StructurePreview,
  type RetrievedConcept,
} from "./wiki/retrieval.ts";