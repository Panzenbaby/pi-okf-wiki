// Synthetic image fixtures for tests, generated with pngjs (no binary files in the repo).

import { PNG } from "pngjs";

export interface RgbImage {
  readonly width: number;
  readonly height: number;
  /** Row-major RGB bytes (3 per pixel). */
  readonly rgb: Buffer;
}

/** A chart-like RGB image: white background, axes, coloured bars, and dark "label" blocks. */
export function createChartRgb(width = 320, height = 200, seed = 1): RgbImage {
  const rgb = Buffer.alloc(width * height * 3, 255);
  const paint = (x: number, y: number, color: readonly [number, number, number]): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = (y * width + x) * 3;
    rgb[index] = color[0];
    rgb[index + 1] = color[1];
    rgb[index + 2] = color[2];
  };
  const fill = (left: number, top: number, right: number, bottom: number, color: readonly [number, number, number]): void => {
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) paint(x, y, color);
  };
  fill(20, height - 22, width - 10, height - 20, [0, 0, 0]);
  fill(20, 10, 22, height - 20, [0, 0, 0]);
  const colors: readonly (readonly [number, number, number])[] = [[63, 106, 153], [230, 96, 20], [76, 175, 80], [220, 70, 70]];
  for (let bar = 0; bar < 4; bar++) {
    const left = 40 + bar * Math.floor((width - 60) / 4);
    const barHeight = 40 + ((bar * 37 + seed * 13) % (height - 80));
    fill(left, height - 22 - barHeight, left + 30, height - 22, colors[bar] ?? [0, 0, 0]);
    // "Text" label: a few dark glyph-like blocks under each bar.
    for (let glyph = 0; glyph < 4; glyph++) fill(left + glyph * 7, height - 16, left + glyph * 7 + 5, height - 8, [20, 20, 20]);
  }
  return { width, height, rgb };
}

/** Correctly encoded PNG of an RGB image. */
export function encodeRgbPng(image: RgbImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = image.rgb;
  return PNG.sync.write(png, { inputColorType: 2, inputHasAlpha: false, colorType: 2 });
}

/**
 * Reproduces the former PDF bug: RGB bytes packed as if they were RGBA,
 * producing channel-rotated, smeared rows.
 */
export function encodeRgbPngAsRgba(image: RgbImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  const padded = Buffer.alloc(image.width * image.height * 4, 255);
  image.rgb.copy(padded);
  png.data = padded;
  return PNG.sync.write(png);
}

/** Horizontal stripes: every other row alternates between two unrelated colourful patterns. */
export function createStripedPng(width = 300, height = 200): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      const even = y % 2 === 0;
      png.data[index] = even ? 240 : 10;
      png.data[index + 1] = even ? 20 : 200;
      png.data[index + 2] = even ? (x * 3) % 256 : 255 - ((x * 3) % 256);
      png.data[index + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** Uniform image of one colour. */
export function createUniformPng(width: number, height: number, value = 255): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(value);
  return PNG.sync.write(png);
}

/** Correctly encoded chart PNG (convenience). */
export function createChartPng(width = 320, height = 200, seed = 1): Buffer {
  return encodeRgbPng(createChartRgb(width, height, seed));
}
