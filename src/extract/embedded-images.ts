// Shared bounded readers for embedded raster images in document containers.
// Libraries' archive/media objects remain inside their repositories; these
// helpers return only the application-level EmbeddedImage model.

import type { EmbeddedImage } from "./types.ts";

export interface EmbeddedImageReference {
  readonly file: EmbeddedZipFile;
  readonly context?: string;
  readonly location?: string;
}

export interface EmbeddedZipFile {
  readonly name: string;
  readonly _data?: { readonly uncompressedSize?: number };
  async(type: "uint8array"): Promise<Uint8Array>;
}

export interface EmbeddedImageResult {
  readonly images: readonly EmbeddedImage[];
  readonly warnings: readonly string[];
}

export const MAX_EMBEDDED_IMAGES = 24;
export const MAX_EMBEDDED_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_EMBEDDED_IMAGE_TOTAL_BYTES = 32 * 1024 * 1024;

/** Reads references independently so one corrupt image does not discard its siblings. */
export async function readEmbeddedImages(
  references: readonly EmbeddedImageReference[],
  format: string,
): Promise<EmbeddedImageResult> {
  const images: EmbeddedImage[] = [];
  const warnings: string[] = [];
  let totalBytes = 0;
  let processedCount = 0;
  for (const reference of references) {
    if (processedCount >= MAX_EMBEDDED_IMAGES) {
      warnings.push(`${format}: skipped ${references.length - processedCount} embedded images after the ${MAX_EMBEDDED_IMAGES}-image limit.`);
      break;
    }
    const mediaType = mediaTypeForName(reference.file.name);
    if (mediaType === undefined) {
      warnings.push(`${format}: skipped embedded image with unsupported format (${reference.file.name}).`);
      continue;
    }
    const knownSize = reference.file._data?.uncompressedSize;
    if (knownSize !== undefined && knownSize > MAX_EMBEDDED_IMAGE_BYTES) {
      warnings.push(`${format}: skipped oversized embedded image (${reference.file.name}, over ${MAX_EMBEDDED_IMAGE_BYTES} bytes).`);
      continue;
    }
    if (knownSize !== undefined && totalBytes + knownSize > MAX_EMBEDDED_IMAGE_TOTAL_BYTES) {
      warnings.push(`${format}: skipped remaining images after the ${MAX_EMBEDDED_IMAGE_TOTAL_BYTES}-byte workload limit.`);
      break;
    }
    processedCount++;
    try {
      const data = await reference.file.async("uint8array");
      if (data.byteLength > MAX_EMBEDDED_IMAGE_BYTES) {
        warnings.push(`${format}: skipped oversized embedded image (${reference.file.name}, ${data.byteLength} bytes).`);
        continue;
      }
      if (totalBytes + data.byteLength > MAX_EMBEDDED_IMAGE_TOTAL_BYTES) {
        warnings.push(`${format}: skipped remaining images after the ${MAX_EMBEDDED_IMAGE_TOTAL_BYTES}-byte workload limit.`);
        break;
      }
      totalBytes += data.byteLength;
      images.push({
        data,
        mediaType,
        ...(reference.context === undefined ? {} : { context: reference.context }),
        ...(reference.location === undefined ? {} : { location: reference.location }),
      });
    } catch (error) {
      warnings.push(`${format}: could not extract embedded image ${reference.file.name}: ${message(error)}.`);
    }
  }
  return { images, warnings };
}

export function mediaTypeForName(name: string): string | undefined {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  const mediaTypes: Readonly<Record<string, string>> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    tif: "image/tiff",
    tiff: "image/tiff",
  };
  return mediaTypes[extension];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
