import { describe, expect, it } from "vitest";

import {
  MAX_EMBEDDED_IMAGE_BYTES,
  MAX_EMBEDDED_IMAGES,
  readEmbeddedImages,
  type EmbeddedImageReference,
} from "../src/extract/embedded-images.ts";

function reference(
  name: string,
  data: Uint8Array,
  options: { readonly fail?: boolean; readonly knownSize?: number } = {},
): EmbeddedImageReference {
  return {
    file: {
      name,
      ...(options.knownSize === undefined ? {} : { _data: { uncompressedSize: options.knownSize } }),
      async: async () => {
        if (options.fail === true) throw new Error("broken image");
        return data;
      },
    },
    location: "Slide 4",
    context: "Revenue overview",
  };
}

describe("readEmbeddedImages", () => {
  it("preserves image bytes, supported media types, and contextual location", async () => {
    const data = new Uint8Array([1, 2, 3]);
    const result = await readEmbeddedImages([reference("chart.png", data)], "pptx");
    expect(result.warnings).toEqual([]);
    expect(result.images).toEqual([
      { data, mediaType: "image/png", sourceName: "chart.png", location: "Slide 4", context: "Revenue overview" },
    ]);
  });

  it("continues after an individual corrupt image and skips the unsupported one", async () => {
    const result = await readEmbeddedImages([
      reference("corrupt.png", new Uint8Array(), { fail: true }),
      reference("drawing.svg", new Uint8Array()),
      reference("chart.jpg", new Uint8Array([4])),
    ], "pptx");
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.mediaType).toBe("image/jpeg");
    expect(result.warnings.join(" ")).toContain("could not extract embedded image corrupt.png");
    expect(result.warnings.join(" ")).toContain("unsupported format (drawing.svg)");
  });

  it("skips oversized images and caps unusually large image workloads", async () => {
    const oversized = reference("large.png", new Uint8Array(), { knownSize: MAX_EMBEDDED_IMAGE_BYTES + 1 });
    const references = [oversized, ...Array.from(
      { length: MAX_EMBEDDED_IMAGES + 2 },
      (_, index) => reference(`image-${index}.png`, new Uint8Array([index % 255])),
    )];
    const result = await readEmbeddedImages(references, "docx");
    expect(result.images).toHaveLength(MAX_EMBEDDED_IMAGES);
    expect(result.warnings.join(" ")).toContain("oversized embedded image");
    expect(result.warnings.join(" ")).toContain("image limit");
  });
});
