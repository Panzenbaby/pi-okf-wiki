// Deterministic, model-free inspection of embedded images: dimensions,
// tiny/decorative detection, and a broken-extraction heuristic.
//
// Everything here is pure (bytes in, verdict out) so the extraction service,
// the evaluation script, and unit tests share exactly one implementation.
//
// Thresholds (documented in README "How images are processed"):
// - Tiny/decorative: both sides < 32 px (icons, bullets, 1×1 spacers), any
//   side < 8 px (rules/lines), or — when dimensions cannot be read — fewer than
//   512 bytes (not enough data for readable content).
// - Broken: extreme aspect ratio (> 40:1), undecodable PNG, a near-uniform
//   (blank) PNG, or a PNG whose pixel neighbourhoods are incoherent (see
//   `assessPngPixels`).

import { PNG } from "pngjs";

/** Both sides below this many pixels => tiny (decorative). */
export const MIN_CONTENT_IMAGE_SIDE_PIXELS = 32;
/** Any side below this many pixels => a line/rule (decorative). */
export const MIN_CONTENT_IMAGE_THIN_SIDE_PIXELS = 8;
/** Without readable dimensions, fewer bytes than this => tiny (decorative). */
export const MIN_CONTENT_IMAGE_BYTES = 512;
/** Longer side / shorter side above this => broken extraction. */
export const MAX_CONTENT_IMAGE_ASPECT_RATIO = 40;
/** PNGs above this many pixels skip the pixel heuristics (cost cap). */
export const MAX_QUALITY_CHECK_PIXELS = 40_000_000;
/** Rows sampled for the pixel heuristics (spread evenly over the height). */
export const QUALITY_CHECK_SAMPLE_ROWS = 240;
/** Luminance standard deviation below this => near-uniform (blank) image. */
export const NEAR_UNIFORM_LUMINANCE_DEVIATION = 2;
/**
 * Neighbour-coherence rule: natural images are spatially autocorrelated, so the
 * mean difference between horizontally adjacent pixels (distance 1) is clearly
 * SMALLER than at distance 3 (measured ratio 0.45–0.65 on real chart
 * screenshots). Mis-decoded pixel data (e.g. RGB bytes read as RGBA) rotates
 * channels from pixel to pixel, which makes adjacent pixels LESS similar than
 * pixels three apart. Broken when distance-1 >= this factor × distance-3.
 */
export const INCOHERENT_NEIGHBOUR_RATIO = 1.15;
/** Minimum mean distance-1 difference (sum over RGBA, 0–1020) for the rule above. */
export const INCOHERENT_NEIGHBOUR_MIN_DIFFERENCE = 12;
/**
 * Row-striping rule: adjacent rows differ about as much as rows two apart
 * (real screenshots: ratio <= 0.75) AND strongly in absolute terms. Catches
 * smeared/striped rows from a wrong row stride.
 */
export const ROW_STRIPING_RATIO = 0.93;
export const ROW_STRIPING_MIN_DIFFERENCE = 40;

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

export type DimensionReading =
  | { readonly kind: "known"; readonly dimensions: ImageDimensions }
  | { readonly kind: "unknown" }
  | { readonly kind: "invalid"; readonly reason: string };

export type ImageQualityVerdict =
  | { readonly kind: "content" }
  | { readonly kind: "tiny"; readonly reason: string }
  | { readonly kind: "broken"; readonly reason: string };

export interface ImageInspection {
  readonly dimensions?: ImageDimensions;
  readonly verdict: ImageQualityVerdict;
}

/** Pixel statistics used by the broken-image heuristic (exported for diagnostics/tests). */
export interface PixelStatistics {
  /** Mean RGBA difference between horizontally adjacent pixels. */
  readonly horizontalDistanceOne: number;
  /** Mean RGBA difference between pixels three columns apart. */
  readonly horizontalDistanceThree: number;
  /** Mean RGBA difference between vertically adjacent pixels. */
  readonly verticalDistanceOne: number;
  /** Mean RGBA difference between pixels two rows apart. */
  readonly verticalDistanceTwo: number;
  /** Standard deviation of luminance (composited over white). */
  readonly luminanceDeviation: number;
}

/** Inspect one image: read its dimensions, then classify it deterministically. */
export function inspectImage(data: Uint8Array, mediaType: string): ImageInspection {
  const reading = readImageDimensions(data, mediaType);
  if (reading.kind === "invalid") {
    return { verdict: { kind: "broken", reason: reading.reason } };
  }
  if (reading.kind === "unknown") {
    if (data.byteLength < MIN_CONTENT_IMAGE_BYTES) {
      return { verdict: { kind: "tiny", reason: `only ${data.byteLength} bytes` } };
    }
    return { verdict: { kind: "content" } };
  }
  const { width, height } = reading.dimensions;
  const dimensions = reading.dimensions;
  if (width < MIN_CONTENT_IMAGE_SIDE_PIXELS && height < MIN_CONTENT_IMAGE_SIDE_PIXELS) {
    return { dimensions, verdict: { kind: "tiny", reason: `${width}×${height} px` } };
  }
  if (Math.min(width, height) < MIN_CONTENT_IMAGE_THIN_SIDE_PIXELS) {
    return { dimensions, verdict: { kind: "tiny", reason: `thin ${width}×${height} px line` } };
  }
  const aspectRatio = Math.max(width, height) / Math.min(width, height);
  if (aspectRatio > MAX_CONTENT_IMAGE_ASPECT_RATIO) {
    return {
      dimensions,
      verdict: { kind: "broken", reason: `extreme aspect ratio ${aspectRatio.toFixed(0)}:1 (${width}×${height} px)` },
    };
  }
  if (mediaType === "image/png" && width * height <= MAX_QUALITY_CHECK_PIXELS) {
    return { dimensions, verdict: assessPng(data) };
  }
  return { dimensions, verdict: { kind: "content" } };
}

function assessPng(data: Uint8Array): ImageQualityVerdict {
  let decoded: { width: number; height: number; data: Buffer };
  try {
    decoded = PNG.sync.read(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  } catch (error) {
    return { kind: "broken", reason: `PNG cannot be decoded (${error instanceof Error ? error.message : String(error)})` };
  }
  return assessPngPixels(measurePixels(decoded.data, decoded.width, decoded.height));
}

/** Apply the broken-image rules to measured pixel statistics. */
export function assessPngPixels(statistics: PixelStatistics): ImageQualityVerdict {
  if (statistics.luminanceDeviation < NEAR_UNIFORM_LUMINANCE_DEVIATION) {
    return { kind: "broken", reason: "near-uniform (blank) image" };
  }
  const horizontalRatio = statistics.horizontalDistanceOne / Math.max(statistics.horizontalDistanceThree, 1e-9);
  if (
    statistics.horizontalDistanceOne >= INCOHERENT_NEIGHBOUR_MIN_DIFFERENCE
    && horizontalRatio >= INCOHERENT_NEIGHBOUR_RATIO
  ) {
    return {
      kind: "broken",
      reason: `incoherent pixel neighbourhoods (adjacent/3-apart difference ratio ${formatRatio(horizontalRatio)}; likely mis-decoded pixel data)`,
    };
  }
  const verticalRatio = statistics.verticalDistanceOne / Math.max(statistics.verticalDistanceTwo, 1e-9);
  if (
    statistics.verticalDistanceOne >= ROW_STRIPING_MIN_DIFFERENCE
    && verticalRatio >= ROW_STRIPING_RATIO
  ) {
    return {
      kind: "broken",
      reason: `row striping (adjacent/2-apart row difference ratio ${formatRatio(verticalRatio)})`,
    };
  }
  return { kind: "content" };
}

function formatRatio(ratio: number): string {
  return ratio > 99 ? ">99" : ratio.toFixed(2);
}

/** Measure neighbour differences on evenly sampled rows of RGBA pixel data. */
export function measurePixels(rgba: Uint8Array, width: number, height: number): PixelStatistics {
  const rowStep = Math.max(1, Math.ceil(height / QUALITY_CHECK_SAMPLE_ROWS));
  let horizontalOne = 0;
  let horizontalThree = 0;
  let horizontalCount = 0;
  let verticalOne = 0;
  let verticalTwo = 0;
  let verticalCount = 0;
  let luminanceSum = 0;
  let luminanceSquareSum = 0;
  let luminanceCount = 0;
  const difference = (left: number, right: number): number =>
    Math.abs((rgba[left] ?? 0) - (rgba[right] ?? 0))
    + Math.abs((rgba[left + 1] ?? 0) - (rgba[right + 1] ?? 0))
    + Math.abs((rgba[left + 2] ?? 0) - (rgba[right + 2] ?? 0))
    + Math.abs((rgba[left + 3] ?? 0) - (rgba[right + 3] ?? 0));
  for (let y = 0; y < height; y += rowStep) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      const alpha = (rgba[index + 3] ?? 255) / 255;
      const luminance = (0.299 * (rgba[index] ?? 0) + 0.587 * (rgba[index + 1] ?? 0) + 0.114 * (rgba[index + 2] ?? 0)) * alpha
        + 255 * (1 - alpha);
      luminanceSum += luminance;
      luminanceSquareSum += luminance * luminance;
      luminanceCount++;
      if (x + 3 < width) {
        horizontalOne += difference(index, index + 4);
        horizontalThree += difference(index, index + 12);
        horizontalCount++;
      }
      if (y + 2 < height) {
        verticalOne += difference(index, index + width * 4);
        verticalTwo += difference(index, index + width * 8);
        verticalCount++;
      }
    }
  }
  const mean = luminanceCount === 0 ? 0 : luminanceSum / luminanceCount;
  const variance = luminanceCount === 0 ? 0 : Math.max(0, luminanceSquareSum / luminanceCount - mean * mean);
  return {
    horizontalDistanceOne: horizontalCount === 0 ? 0 : horizontalOne / horizontalCount,
    horizontalDistanceThree: horizontalCount === 0 ? 0 : horizontalThree / horizontalCount,
    verticalDistanceOne: verticalCount === 0 ? 0 : verticalOne / verticalCount,
    verticalDistanceTwo: verticalCount === 0 ? 0 : verticalTwo / verticalCount,
    luminanceDeviation: Math.sqrt(variance),
  };
}

/** Read width/height from the image header without decoding pixel data. */
export function readImageDimensions(data: Uint8Array, mediaType: string): DimensionReading {
  switch (mediaType) {
    case "image/png":
      return readPngDimensions(data);
    case "image/jpeg":
      return readJpegDimensions(data);
    case "image/gif":
      return readGifDimensions(data);
    case "image/bmp":
      return readBmpDimensions(data);
    case "image/webp":
      return readWebpDimensions(data);
    default:
      return { kind: "unknown" };
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function readPngDimensions(data: Uint8Array): DimensionReading {
  if (data.byteLength < 24 || PNG_SIGNATURE.some((byte, index) => data[index] !== byte)) {
    return { kind: "invalid", reason: "missing PNG signature/header" };
  }
  return known(readUint32BigEndian(data, 16), readUint32BigEndian(data, 20));
}

function readJpegDimensions(data: Uint8Array): DimensionReading {
  if (data.byteLength < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
    return { kind: "invalid", reason: "missing JPEG start-of-image marker" };
  }
  let offset = 2;
  while (offset + 9 < data.byteLength) {
    if (data[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = data[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const segmentLength = readUint16BigEndian(data, offset + 2);
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      return known(readUint16BigEndian(data, offset + 7), readUint16BigEndian(data, offset + 5));
    }
    if (segmentLength < 2) break;
    offset += 2 + segmentLength;
  }
  return { kind: "unknown" };
}

function readGifDimensions(data: Uint8Array): DimensionReading {
  if (data.byteLength < 10 || String.fromCharCode(...data.subarray(0, 4)) !== "GIF8") {
    return { kind: "invalid", reason: "missing GIF header" };
  }
  return known(readUint16LittleEndian(data, 6), readUint16LittleEndian(data, 8));
}

function readBmpDimensions(data: Uint8Array): DimensionReading {
  if (data.byteLength < 26 || data[0] !== 0x42 || data[1] !== 0x4d) {
    return { kind: "invalid", reason: "missing BMP header" };
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return known(Math.abs(view.getInt32(18, true)), Math.abs(view.getInt32(22, true)));
}

function readWebpDimensions(data: Uint8Array): DimensionReading {
  if (
    data.byteLength < 30
    || String.fromCharCode(...data.subarray(0, 4)) !== "RIFF"
    || String.fromCharCode(...data.subarray(8, 12)) !== "WEBP"
  ) {
    return { kind: "invalid", reason: "missing WebP header" };
  }
  const chunk = String.fromCharCode(...data.subarray(12, 16));
  if (chunk === "VP8 ") {
    return known(readUint16LittleEndian(data, 26) & 0x3fff, readUint16LittleEndian(data, 28) & 0x3fff);
  }
  if (chunk === "VP8L") {
    const bits = (data[21] ?? 0) | ((data[22] ?? 0) << 8) | ((data[23] ?? 0) << 16) | ((data[24] ?? 0) << 24);
    return known((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === "VP8X") {
    const width = 1 + ((data[24] ?? 0) | ((data[25] ?? 0) << 8) | ((data[26] ?? 0) << 16));
    const height = 1 + ((data[27] ?? 0) | ((data[28] ?? 0) << 8) | ((data[29] ?? 0) << 16));
    return known(width, height);
  }
  return { kind: "unknown" };
}

function known(width: number, height: number): DimensionReading {
  if (width <= 0 || height <= 0) return { kind: "invalid", reason: `invalid dimensions ${width}×${height}` };
  return { kind: "known", dimensions: { width, height } };
}

function readUint32BigEndian(data: Uint8Array, offset: number): number {
  return (((data[offset] ?? 0) << 24) >>> 0) + ((data[offset + 1] ?? 0) << 16) + ((data[offset + 2] ?? 0) << 8) + (data[offset + 3] ?? 0);
}

function readUint16BigEndian(data: Uint8Array, offset: number): number {
  return ((data[offset] ?? 0) << 8) + (data[offset + 1] ?? 0);
}

function readUint16LittleEndian(data: Uint8Array, offset: number): number {
  return (data[offset] ?? 0) + ((data[offset + 1] ?? 0) << 8);
}
