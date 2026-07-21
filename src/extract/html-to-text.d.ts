// Minimal ambient declaration for `html-to-text` (the package ships no .d.ts).
// Only the surface this extension uses is typed; keep it narrow and explicit
// (no `any`).

declare module "html-to-text" {
  export interface HtmlToTextSelectorOptions {
    [key: string]: unknown;
  }

  export interface HtmlToTextSelector {
    readonly selector: string;
    readonly options?: HtmlToTextSelectorOptions;
    readonly format?: string;
  }

  export interface HtmlToTextOptions {
    readonly wordwrap?: number | false;
    readonly selectors?: ReadonlyArray<HtmlToTextSelector>;
    readonly baseElements?: unknown;
    readonly limits?: unknown;
    readonly [key: string]: unknown;
  }

  export function htmlToText(html: string, options?: HtmlToTextOptions): string;
  export function compile(options?: HtmlToTextOptions): (html: string) => string;
  export const convert: typeof htmlToText;
}