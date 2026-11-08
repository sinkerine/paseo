import { classifyAssistantFileLink } from "@/assistant-file-links";
import { ASSISTANT_FILE_EXTENSIONS } from "@/assistant-file-links/extensions";
import { normalizeMarkdownHtml } from "./html";
import { collectMathEdits, needsMathAdaptation, type SourceEdit, type SourceRange } from "./math";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import type { AssistantFileLinkSource } from "@/assistant-file-links";
import { decodeString } from "micromark-util-decode-string";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Link, Nodes, Paragraph, PhrasingContent, Root } from "mdast";

// Keep this regex in the syntax shared by JavaScript, ICU and java.util.regex.
// The Unicode flag makes Metro expand it to escapes rejected by native engines.
const PATH_CHARACTER = String.raw`[a-zA-Z0-9\u0080-\uFFFF_@.%+-]`;
const PATH_LETTER = String.raw`[a-zA-Z]`;
const PATH_SEGMENT = String.raw`${PATH_CHARACTER}*[a-zA-Z0-9\u0080-\uFFFF_@%+-]`;
const LINE_SUFFIX = String.raw`(?::\d+(?::\d+)?(?:-\d+(?::\d+)?)?)?`;
const FILE_EXTENSIONS = [...ASSISTANT_FILE_EXTENSIONS]
  .map((extension) => extension.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`))
  .join("|");
const PATH_PREFIX = String.raw`(?:[A-Za-z]:[\\/]|\.{0,2}\/|~\/)`;
const HAS_PATH_LETTER = String.raw`(?=${PATH_CHARACTER}*(?:[\\/]${PATH_CHARACTER}*)*${PATH_LETTER})`;
const SEPARATED_PATH = String.raw`${PATH_SEGMENT}(?:[\\/]${PATH_SEGMENT})+`;
const FILE_NAME = String.raw`${PATH_SEGMENT}\.(?:${FILE_EXTENSIONS})`;
// Bare prose paths need a known extension, a line suffix, or at least two separators.
const PROSE_PATH = String.raw`(?:${PATH_PREFIX}${HAS_PATH_LETTER}${SEPARATED_PATH}|${HAS_PATH_LETTER}(?:${PATH_SEGMENT}(?:[\\/]${PATH_SEGMENT})*[\\/]${FILE_NAME}|${PATH_SEGMENT}(?:[\\/]${PATH_SEGMENT}){2,}|${SEPARATED_PATH}(?=:)))`;

function createTextPattern(path: string, forgeReferencePattern?: string): RegExp {
  // Forge references come before paths so `group/project#12` is not read as a path.
  const forgeReference = forgeReferencePattern ? `|${forgeReferencePattern}` : "";
  // The native adapter mistakes a literal + in lookbehind for a quantifier; use its hex escape.
  return new RegExp(
    String.raw`(?:${BARE_URL}${forgeReference}|(?<![a-zA-Z0-9\u0080-\uFFFF_@.%\x2b~:/\\-])(?:${path}|${FILE_NAME})${LINE_SUFFIX}(?![a-zA-Z0-9\u0080-\uFFFF_@%+:/\\-]|\.${PATH_CHARACTER}))`,
    "g",
  );
}

// Matches bare URLs that MD4C does not autolink, like single-label or bracketed hosts.
// Quotes and unbalanced closing parentheses end the URL. Trailing sentence punctuation stays outside.
const URL_CHARACTER = String.raw`[^\s<>()"'\x60]`;
const URL_GROUP = String.raw`\(${URL_CHARACTER}*\)`;
const BARE_URL = String.raw`https?://(?:${URL_CHARACTER}|${URL_GROUP})*(?:[^\s<>()"'\x60.,;:!?]|${URL_GROUP})`;

const TEXT_PATTERN = createTextPattern(PROSE_PATH);
// One entry per distinct workspace forge remote; reuse keeps the engine's regex identity stable.
const textPatternsByForgeReference = new Map<string, RegExp>();
function textPattern(forgeReferencePattern?: string): RegExp {
  if (!forgeReferencePattern) return TEXT_PATTERN;
  let pattern = textPatternsByForgeReference.get(forgeReferencePattern);
  if (!pattern) {
    pattern = createTextPattern(PROSE_PATH, forgeReferencePattern);
    textPatternsByForgeReference.set(forgeReferencePattern, pattern);
  }
  return pattern;
}

function linkMetadata(inlineCodePaths: ReadonlySet<string>, forgeReferencePattern?: string) {
  // The engine accepts regexes on both platforms. Classify complete code spans
  // first, then pass literal matches rather than maintaining a second path grammar.
  const alternatives = [...inlineCodePaths].map((path) =>
    path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return {
    linkRecognition: {
      text: textPattern(forgeReferencePattern),
      inlineCode: new RegExp(
        String.raw`^(?:https?://[^\s<>]+${alternatives.length ? `|${alternatives.join("|")}` : ""})$`,
      ),
    },
    linkSource: markdownLinkSource,
  };
}

function collectInlineCodePaths(
  source: string,
  workspaceRoot?: string,
  commandNames?: ReadonlySet<string>,
): ReadonlySet<string> {
  const paths = new Set<string>();
  const previousEnds = new Map<number, number>();
  // Collect candidates between consecutive runs of equal length. The engine owns
  // Markdown context (escapes, fences, authored links); extra candidates are harmless
  // because recognition only applies to complete Code nodes. This avoids an AST
  // parse on every streaming reveal, including updates inside long code fences.
  for (const match of source.matchAll(/`+/g)) {
    const length = match[0].length;
    const previousEnd = previousEnds.get(length);
    previousEnds.set(length, match.index + length);
    if (previousEnd === undefined) continue;
    let value = source.slice(previousEnd, match.index).replace(/\r\n?|\n/g, " ");
    // CommonMark code spans replace line endings and strip one surrounding space.
    if (value.startsWith(" ") && value.endsWith(" ") && /[^ ]/.test(value)) {
      value = value.slice(1, -1);
    }
    const classification = classifyAssistantFileLink(value, { workspaceRoot });
    if (
      (classification && classification.kind !== "external") ||
      (value.startsWith("/") && commandNames?.has(value.slice(1)))
    )
      paths.add(value);
  }
  return paths;
}

export function markdownLinkSource(
  url: string,
  sourceType?: "markdown" | "text" | "inline-code",
): AssistantFileLinkSource {
  if (sourceType === "inline-code") return { href: url, text: url, sourceType };
  if (sourceType === "text") return { href: url, text: url, markup: "linkify" };
  return { href: url, text: url };
}

// Generated by scripts/generate-markdown-image-placeholder.mjs; reserves the image box.
export const PENDING_MARKDOWN_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAoAAAAKACAYAAAAMzckjAAAACXBIWXMAAAsTAAALEwEAmpwYAAAKBklEQVR42u3dXWscVRgH8ElFLK032tiCN1nSEiiowdKAn8DY2rR+AG965Qt4Y24Sm91kd5tN1ogQaGzzFfIl43Nki+s4u+m+ZWfC7weH0M6Z2QPn5s8zc87JMgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgKvm/Px8YXd3d7Hdbi/Ns6UxxHAWzAgAwIxE4LrebDafxd/f9/b2TkvSujGep2lsZggAYIr29/c/iZDVKlHwy7dmryIIAEA2hcpfo9Folzj89YdAlUAAgEml174VCH//tBjrhhkDAMgmXvDxn2/+4t+von0dbXmOC0CW6/X6ehpL/9iiUtnNLAwBAMgmef27mK+ypfCXlac6uZ4fX6fTuWXmAADGD4C1fMCKCtzdsowvjaUgoNbMHADA+AFwuSBgLRsfAIAAmL/vRrSVVqu1mipy0a4JgAAAVzAAbm9v34nrP0a/17l7/oz25PT09H0BEADgigTAnZ2d+3H9eNg2LXHvb9E+FAABACoeAFPl76Lw13f/r9mUtmoRAAEA5hQAe69933nD5uj/UAAEAKhoAOwt+Pgr1+cwFoB8Hn9vx159j+Lvm9xzfhEAAQCqGwBXCvp80d8n/u957vofAiAAQEUDYCz+WC3oczv3nMe5I9tOBEAAgOpWAP93Wkh67fv2+tnZ2Xtp9W+uz74ACABQ3QB4Le3zl+uTvvl73qv8vSh4xvcCIABAhVcB1+v1jRFWAb+OZ3x60RnE0b6Lvj+kFhXFZ3Hu75IACABQkgCYTvgoeM07aAuYx4N+7+jo6GZc/3nI/T9tbm7eFAABAEpwEkg64SOubw6r/EUl79tswCbQW1tbH8XikPZFATL1SX0FQACAEpwFnMJd2uQ57fMX7SjaSVrwkb75G/baNwW6uP5yhI2kX/buEQABAOYcAEd2Qfh7Edd2BoXA2Gx6VQAEAKhQABwU/tLJIrGwZC37d5HJWv60kd7r4K4ACABQkQCYwl88rz3gW8G1fP+o9n1ZFAIFQACACgTAUcPfKCFQAAQAKFkAHDf8vWsIFAABAEoUAId98xftwQjjejAoBHY6nXtmDgCgBAFwWuGvPwSmqmHB874ycwAAcw6A0w5/b8Ur40f5Z8Yr4vtmDgBgjgFwVuHPSSAAACUMgJMu+BAAAQAqFABnHf4EQACAEgXAywh/AiAAQEkC4GWFPwEQAKAEAfAyw58ACAAw5wB42eFPAAQAmE3AquUDVrvdvluG8Ncb372CAFgzcwAA4wesxXzAqtfr62UIf73xfVNwFNwtMwcAML6FCFXdXIXtVQS79fSqNdpn0Q4LqnBv0ikdUS1cmkVLv52e32g0TnK/e5jGbNoAALKJqmxPC6p7pWwx1idmDABg8gB4PcJVswLhb+/4+PgDMwYAMKVvAaO1yhz+0hjNFADAFKXqWnx3txHf3XVLFPwO02tflT8AgNlaSCtt02KMg4ODWlrpGyFsZVYLPoYsBPnYgg8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOBK+hsMQ7RDjzvGwwAAAABJRU5ErkJggg==";

export interface MarkdownImage {
  source: string;
  alt: string;
  title: string | null;
  start: number;
  end: number;
}

function workspaceHoverTitle(link: Link, markup: string, workspaceRoot?: string): string | null {
  if (link.title !== null || !workspaceRoot || !link.url.startsWith(`${workspaceRoot}/`))
    return null;
  // mdast represents both missing titles and authored empty titles as null.
  if (/\s(?:""|''|\(\))\s*\)$/.test(markup)) return null;
  return link.url.slice(workspaceRoot.length + 1);
}

/** MD4C flags for the shared renderer. Math is web-only until native builds include RaTeX. */
export function md4cFlags(supportsMath: boolean) {
  return { latexMath: supportsMath, hardSoftBreaks: true, admonitions: true } as const;
}

// Merging makes both starts and ends monotonic, including nested delimiter edits.
function mergeRanges(ranges: readonly SourceRange[]): SourceRange[] {
  const merged: SourceRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged;
}

// Ranges must be sorted and disjoint. Only intersecting ranges need visiting.
function firstRangeEndingAfter(ranges: readonly SourceRange[], offset: number): number {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (ranges[middle].end <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Preserve source spelling; adapt images, spoilers, entities, and supported math delimiters. */
export function prepareMarkdownSource(
  source: string,
  workspaceRoot?: string,
  options: {
    supportsSvg?: boolean;
    supportsMath?: boolean;
    commandNames?: ReadonlySet<string>;
    /** Regex source for forge references such as `#12`; see `@/git/forge-shorthand`. */
    forgeReferencePattern?: string;
  } = {},
) {
  source = normalizeMarkdownHtml(source);
  const images: MarkdownImage[] = [];
  let tree: Root | undefined;
  const getTree = () =>
    (tree ??= fromMarkdown(source, {
      extensions: [gfmTable()],
      mdastExtensions: [gfmTableFromMarkdown()],
    }));
  const metadata = linkMetadata(
    collectInlineCodePaths(source, workspaceRoot, options.commandNames),
    options.forgeReferencePattern,
  );
  const edits: { start: number; end: number; text: string }[] = [];
  if (
    !source.includes("![") &&
    !source.includes("||") &&
    !source.includes("&") &&
    !(options.supportsMath && needsMathAdaptation(source)) &&
    // Match content, header, and delimiter lines; quote-only lines count as blank.
    !/^[\t >]*[^\t >\r\n][^\r\n]*(?:\r\n|\r|\n)[^\r\n]+(?:\r\n|\r|\n)(?=[\t >:|-]*\|)[\t >|]*:?-[-\t :|]*$/m.test(
      source,
    ) &&
    !(workspaceRoot && source.includes("]("))
  ) {
    return { images, ...metadata, render: () => source };
  }

  const literal: SourceRange[] = [];
  const opaque: SourceRange[] = [];
  const references: Extract<Nodes, { type: "linkReference" }>[] = [];
  function collectLiteral(node: Nodes) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (["code", "inlineCode", "html"].includes(node.type)) {
      literal.push({ start, end });
      return;
    }
    if (["image", "imageReference", "definition"].includes(node.type)) {
      opaque.push({ start, end });
      return;
    }
    if (node.type === "link" || node.type === "linkReference") {
      if (source[start] !== "[") {
        // Autolink text is also its destination.
        opaque.push({ start, end });
        return;
      }
      const labelStart = node.children[0]?.position?.start.offset ?? start + 1;
      const labelEnd = node.children.at(-1)?.position?.end.offset ?? labelStart;
      opaque.push({ start, end: labelStart }, { start: labelEnd, end });
      if (node.type === "linkReference" && node.referenceType !== "full") references.push(node);
    }
    if ("children" in node) node.children.forEach(collectLiteral);
  }
  let math: SourceRange[] = [];
  let protectedText: SourceRange[] = [];
  if (options.supportsMath) {
    collectLiteral(getTree());
    const collected = collectMathEdits(source, literal, opaque);
    for (const edit of collected.edits) edits.push(edit);
    math = collected.math;
    protectedText = mergeRanges([...math, ...collected.edits]);
  }
  function addEdit(edit: SourceEdit) {
    const range = math[firstRangeEndingAfter(math, edit.start)];
    const lastOffset = Math.max(edit.start, edit.end - 1);
    if (range && range.start <= lastOffset) return;
    edits.push(edit);
  }

  const definitions = new Map<string, { url: string; title?: string | null }>();
  function definitionsIn(node: Nodes) {
    if (node.type === "definition" && !definitions.has(node.identifier))
      definitions.set(node.identifier, node);
    if ("children" in node) node.children.forEach(definitionsIn);
  }
  definitionsIn(getTree());
  function collectImage(
    node: Extract<Nodes, { type: "image" | "imageReference" }>,
    start: number,
    end: number,
  ) {
    const target = node.type === "image" ? node : definitions.get(node.identifier);
    if (
      target &&
      options.supportsSvg === false &&
      /(?:\.svg(?:[?#]|$)|^data:image\/svg\+xml)/i.test(target.url)
    ) {
      addEdit({ start, end, text: escapeMarkdownText(node.alt ?? "") });
      return;
    }
    if (target)
      images.push({
        source: target.url,
        alt: node.alt ?? "",
        title: target.title ?? null,
        start,
        end,
      });
  }
  // Line boundaries already turned into paragraph breaks, by offset of their newline.
  const splitBoundaries = new Set<number>();
  function isImageLike(node: PhrasingContent): boolean {
    if (node.type === "image" || node.type === "imageReference") return true;
    return (
      (node.type === "link" || node.type === "linkReference") &&
      node.children.length === 1 &&
      isImageLike(node.children[0])
    );
  }
  // An image alone on its line becomes its own paragraph, so every platform renders
  // it as a block. The library only treats sole-child paragraph images as blocks;
  // with hardSoftBreaks every newline is a break node, which made these inline.
  function splitStandaloneImages(paragraph: Paragraph, start: number, end: number) {
    for (const child of paragraph.children) {
      const childStart = child.position?.start.offset;
      const childEnd = child.position?.end.offset;
      if (childStart === undefined || childEnd === undefined || !isImageLike(child)) continue;
      const lineStart = source.lastIndexOf("\n", childStart - 1) + 1;
      const newline = source.indexOf("\n", childEnd);
      const lineEnd = newline === -1 ? source.length : newline;
      const prefix = source.slice(lineStart, childStart);
      const suffix = source.slice(childEnd, lineEnd);
      const aloneBefore = childStart === start || /^[\s>]*$/.test(prefix);
      const aloneAfter = /^\s*\\?$/.test(suffix);
      if (!aloneBefore || !aloneAfter) continue;
      // Continuation lines inside quotes and lists keep their quote markers on the blank line.
      const blank = prefix.replace(/[^>]/g, " ").trimEnd();
      const split = (boundary: number) => {
        if (splitBoundaries.has(boundary)) return;
        splitBoundaries.add(boundary);
        // A trailing backslash was a hard break; at a paragraph end it would render literally.
        const cut = source[boundary - 1] === "\\" ? boundary - 1 : boundary;
        addEdit({ start: cut, end: boundary + 1, text: `\n${blank}\n` });
      };
      if (lineStart > start) split(lineStart - 1);
      if (lineEnd < end) split(lineEnd);
    }
  }
  function adaptText(start: number, end: number) {
    if (start === end) return;
    const original = source.slice(start, end);
    const text = original
      .replace(/(?<!\\)&(?:#(?:[xX][\da-fA-F]+|\d+)|[a-zA-Z][a-zA-Z\d]+);/g, (entity) =>
        decodeString(entity).replace(/[!-/:-@[-`{-~]/g, "\\$&"),
      )
      .replace(/(?<!\\)\|\|/g, "\\|\\|");
    if (text !== original) addEdit({ start, end, text });
  }
  function splitTableFromParagraph(
    node: Nodes,
    previous: Nodes | undefined,
    start: number,
    line: number,
  ) {
    if (
      node.type !== "table" ||
      previous?.type !== "paragraph" ||
      previous.position?.end.line !== line - 1
    )
      return;
    // MD4C only recognizes a table header on the first line of a paragraph.
    const lineStart =
      Math.max(source.lastIndexOf("\n", start - 1), source.lastIndexOf("\r", start - 1)) + 1;
    const newline = source.slice(lineStart - 2, lineStart).replace(/[^\r\n]/g, "");
    const blank = source.slice(lineStart, start).replace(/[^>]/g, " ").trimEnd();
    const boundary = lineStart - newline.length;
    addEdit({ start: boundary, end: lineStart, text: `${newline}${blank}${newline}` });
  }
  function visit(node: Nodes, previous?: Nodes) {
    const position = node.position;
    const start = position?.start.offset;
    const end = node.position?.end.offset;
    if (position && start !== undefined && end !== undefined) {
      const containingMath = math[firstRangeEndingAfter(math, start)];
      if (containingMath && start >= containingMath.start && end <= containingMath.end) return;
      if (node.type === "paragraph") splitStandaloneImages(node, start, end);
      splitTableFromParagraph(node, previous, start, position.start.line);
      if (node.type === "link") {
        const title = workspaceHoverTitle(node, source.slice(start, end), workspaceRoot);
        if (title !== null)
          addEdit({ start: end - 1, end: end - 1, text: ` ${JSON.stringify(title)}` });
      }
      if (node.type === "tableRow") {
        // MD4C's always-enabled spoiler extension otherwise consumes adjacent cell
        // delimiters. Spaces keep empty GFM cells empty without producing spoilers.
        const row = source.slice(start, end);
        for (const match of row.matchAll(/(?<!\\)\|(?=\|)/g)) {
          addEdit({ start: start + match.index + 1, end: start + match.index + 1, text: " " });
        }
      }
      if (node.type === "image" || node.type === "imageReference") {
        collectImage(node, start, end);
        return;
      }
      if (node.type === "text") {
        let cursor = start;
        const first = firstRangeEndingAfter(protectedText, start);
        for (let index = first; index < protectedText.length; index++) {
          const range = protectedText[index];
          if (range.start >= end) break;
          adaptText(cursor, Math.max(cursor, range.start));
          cursor = Math.min(end, range.end);
        }
        adaptText(cursor, end);
      }
    }
    if ("children" in node)
      node.children.forEach((child, index) => visit(child, node.children[index - 1]));
  }
  visit(getTree());
  function preserveReferenceKeys() {
    if (!references.length) return;
    // Include all adaptations: a lone dollar, entity or spoiler can change the key
    // just as bracket math does. Index once after all visible text edits are known.
    const changedLabels = mergeRanges(edits);
    for (const reference of references) {
      const start = reference.position?.start.offset;
      const end = reference.position?.end.offset;
      if (start === undefined || end === undefined) continue;
      const labelStart = reference.children[0]?.position?.start.offset ?? start + 1;
      const labelEnd = reference.children.at(-1)?.position?.end.offset ?? labelStart;
      const change = changedLabels[firstRangeEndingAfter(changedLabels, labelStart)];
      if (!change || change.start >= labelEnd) continue;
      // Shortcut/collapsed labels also name the definition. Retain the authored key
      // when adapting the visible label, or the destination would become unresolved.
      const suffixStart = labelEnd + 1;
      addEdit({ start: suffixStart, end, text: source.slice(start, suffixStart) });
    }
  }
  preserveReferenceKeys();
  return {
    images,
    ...metadata,
    render(
      urls: ReadonlyMap<string, string> = new Map(),
      unavailableImages: ReadonlySet<string> = new Set(),
      pendingImages: ReadonlySet<string> = new Set(),
    ) {
      const replacements = [...edits];
      for (const image of images) {
        const unavailable = unavailableImages.has(image.source);
        const pending = pendingImages.has(image.source);
        if (!unavailable && !pending && /^(https?:|data:|blob:)/i.test(image.source)) continue;
        let url = unavailable ? undefined : urls.get(image.source);
        if (pending && !unavailable) url = PENDING_MARKDOWN_IMAGE;
        replacements.push({
          start: image.start,
          end: image.end,
          text: url
            ? `![${image.alt.replace(/[[\]\\]/g, "\\$&")}](<${url}>${image.title ? ` ${JSON.stringify(image.title)}` : ""})`
            : escapeMarkdownText(image.alt),
        });
      }
      // Copy each source gap once. Rebuilding the full string per edit is quadratic
      // for completed messages with many formulas. Reverse assembly preserves the
      // existing order of insertions at the same offset.
      const chunks: string[] = [];
      let cursor = source.length;
      for (const edit of replacements.sort((a, b) => b.start - a.start)) {
        chunks.push(source.slice(edit.end, cursor), edit.text);
        cursor = edit.start;
      }
      chunks.push(source.slice(0, cursor));
      return chunks.toReversed().join("");
    },
  };
}

function escapeMarkdownText(text: string): string {
  return text.replace(/[!-/:-@[-`{-~]/g, "\\$&");
}
