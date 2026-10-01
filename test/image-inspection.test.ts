import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import {
  MAX_CONTENT_IMAGE_ASPECT_RATIO,
  inspectImage,
  readImageDimensions,
} from "../src/extract/image-inspection.ts";
import { encodePng } from "../src/extract/pdf.ts";
import {
  createChartPng,
  createChartRgb,
  createStripedPng,
  createUniformPng,
  encodeRgbPng,
  encodeRgbPngAsRgba,
} from "./support/images.ts";

describe("inspectImage", () => {
  it("accepts chart-like images as content", () => {
    for (const seed of [1, 2, 3]) {
      const inspection = inspectImage(createChartPng(320, 200, seed), "image/png");
      expect(inspection.verdict).toEqual({ kind: "content" });
      expect(inspection.dimensions).toEqual({ width: 320, height: 200 });
    }
  });

  it("flags RGB pixel data packed as RGBA (the striped/smeared PDF failure) as broken", () => {
    for (const seed of [1, 2, 3]) {
      const image = createChartRgb(320, 200, seed);
      expect(inspectImage(encodeRgbPng(image), "image/png").verdict.kind).toBe("content");
      const garbled = inspectImage(encodeRgbPngAsRgba(image), "image/png");
      expect(garbled.verdict.kind).toBe("broken");
      if (garbled.verdict.kind === "broken") expect(garbled.verdict.reason).toContain("incoherent pixel neighbourhoods");
    }
  });

  it("flags strong row striping as broken", () => {
    const inspection = inspectImage(createStripedPng(), "image/png");
    expect(inspection.verdict.kind).toBe("broken");
    if (inspection.verdict.kind === "broken") expect(inspection.verdict.reason).toContain("row striping");
  });

  it("flags near-uniform images and extreme aspect ratios as broken", () => {
    expect(inspectImage(createUniformPng(200, 120), "image/png").verdict).toEqual({ kind: "broken", reason: "near-uniform (blank) image" });
    const banner = inspectImage(createChartPng(MAX_CONTENT_IMAGE_ASPECT_RATIO * 10 + 10, 10), "image/png");
    expect(banner.verdict.kind).toBe("broken");
  });

  it("classifies tiny and thin images as decorative-tiny", () => {
    expect(inspectImage(createUniformPng(1, 1, 0), "image/png").verdict.kind).toBe("tiny");
    expect(inspectImage(createUniformPng(24, 24, 0), "image/png").verdict.kind).toBe("tiny");
    expect(inspectImage(createUniformPng(300, 4, 0), "image/png").verdict.kind).toBe("tiny");
    // Small byte payload of a format whose dimensions are not read (TIFF).
    expect(inspectImage(new Uint8Array(100), "image/tiff").verdict.kind).toBe("tiny");
    expect(inspectImage(new Uint8Array(4096), "image/tiff").verdict.kind).toBe("content");
  });

  it("flags payloads whose header does not match the media type as broken", () => {
    expect(inspectImage(Buffer.from("definitely not a png, but long enough to be a header"), "image/png").verdict.kind).toBe("broken");
  });
});

describe("readImageDimensions", () => {
  it("reads JPEG, GIF, and BMP headers", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x90, 0x02, 0x58, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(readImageDimensions(jpeg, "image/jpeg")).toEqual({ kind: "known", dimensions: { width: 600, height: 400 } });
    const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xc8, 0x00]);
    expect(readImageDimensions(gif, "image/gif")).toEqual({ kind: "known", dimensions: { width: 320, height: 200 } });
    const bmp = Buffer.alloc(30);
    bmp.write("BM", 0, "latin1");
    bmp.writeInt32LE(64, 18);
    bmp.writeInt32LE(-48, 22);
    expect(readImageDimensions(bmp, "image/bmp")).toEqual({ kind: "known", dimensions: { width: 64, height: 48 } });
  });
});

describe("PDF PNG encoding", () => {
  it("passes the raw RGB layout to the packer so pixels survive a round trip", () => {
    const source = createChartRgb(64, 40, 2);
    const decoded = PNG.sync.read(encodePng({ data: source.rgb, width: 64, height: 40, channels: 3 }));
    for (let pixel = 0; pixel < 64 * 40; pixel++) {
      expect([decoded.data[pixel * 4], decoded.data[pixel * 4 + 1], decoded.data[pixel * 4 + 2]])
        .toEqual([source.rgb[pixel * 3], source.rgb[pixel * 3 + 1], source.rgb[pixel * 3 + 2]]);
    }
    expect(inspectImage(encodePng({ data: source.rgb, width: 64, height: 40, channels: 3 }), "image/png").verdict.kind).toBe("content");
  });
});
