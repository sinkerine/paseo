export interface SourceRange {
  start: number;
  end: number;
}

export interface SourceEdit extends SourceRange {
  text: string;
}

/** True when source may contain bracket math or a dollar that cannot delimit math. */
export function needsMathAdaptation(source: string): boolean {
  return /\\[[(]|(?<!\$)\$(?!\$)(?=\s|$)/.test(source);
}

function isInlineBoundary(character: string | undefined): boolean {
  return character === undefined || /[\s!-/:-@[-`{-~]/.test(character);
}

function isLoneDollar(source: string, index: number): boolean {
  const single = source[index - 1] !== "$" && source[index + 1] !== "$";
  const spaceBefore = index === 0 || /\s/.test(source[index - 1]);
  const spaceAfter = index + 1 === source.length || /\s/.test(source[index + 1]);
  return single && spaceBefore && spaceAfter;
}

interface Delimiter {
  index: number;
  kind:
    | "displayOpen"
    | "inlineOpen"
    | "displayClose"
    | "inlineClose"
    | "dollar"
    | "boundary"
    | "newline";
  close?: number;
}

function displayLineEnds(source: string): Uint8Array {
  const ends = new Uint8Array(source.length);
  let whitespace = true;
  for (let index = source.length - 1; index >= 0; index--) {
    ends[index] = Number(whitespace);
    whitespace = source[index] === "\n" || (whitespace && /\s/.test(source[index]));
  }
  return ends;
}

function bracketDelimiter(
  source: string,
  index: number,
  prefixEnd: number,
  displayEnd: Uint8Array,
): Delimiter["kind"] | undefined {
  switch (source[index + 1]) {
    case "[":
      return index <= prefixEnd ? "displayOpen" : undefined;
    case "(":
      return isInlineBoundary(source[index - 1]) ? "inlineOpen" : undefined;
    case "]":
      return displayEnd[index + 1] ? "displayClose" : undefined;
    case ")":
      return isInlineBoundary(source[index + 2]) ? "inlineClose" : undefined;
  }
}

function excludedCharacters(
  source: string,
  literal: readonly SourceRange[],
  opaque: readonly SourceRange[],
) {
  const excluded = new Uint8Array(source.length);
  for (const range of opaque) excluded.fill(1, range.start, range.end);
  for (const range of literal) excluded.fill(2, range.start, range.end);
  return excluded;
}

function linePrefixEnd(source: string, start: number, prefix: RegExp): number {
  prefix.lastIndex = start;
  return start + (prefix.exec(source)?.[0].length ?? 0);
}

function collectDelimiters(
  source: string,
  literal: readonly SourceRange[],
  opaque: readonly SourceRange[],
) {
  const excluded = excludedCharacters(source, literal, opaque);
  const displayEnd = displayLineEnds(source);

  // Each line prefix is matched once. Sticky matching avoids slicing suffixes.
  const displayPrefix =
    /[^\S\r\n>]*(?:>[^\S\r\n>]*)*(?:(?:[-*+]|\d+[.)])[^\S\r\n]+)?[^\S\r\n>]*(?:>[^\S\r\n>]*)*/y;
  const delimiters: Delimiter[] = [];
  let escaped = false;
  let prefixEnd = 0;
  for (let index = 0; index < source.length; index++) {
    if (index === 0 || source[index - 1] === "\n") {
      prefixEnd = linePrefixEnd(source, index, displayPrefix);
    }
    const character = source[index];
    const wasEscaped = escaped;
    escaped = character === "\\" && !escaped;
    if (excluded[index] === 2) {
      if (index === 0 || excluded[index - 1] !== 2) {
        delimiters.push({ index, kind: "boundary" });
      }
      continue;
    }
    if (character === "\n" || character === "\r") delimiters.push({ index, kind: "newline" });
    if (excluded[index] || wasEscaped) continue;
    if (character === "$" && isLoneDollar(source, index)) {
      delimiters.push({ index, kind: "dollar" });
    }
    if (character !== "\\" || index + 1 >= source.length || excluded[index + 1]) continue;
    const kind = bracketDelimiter(source, index, prefixEnd, displayEnd);
    if (kind) delimiters.push({ index, kind });
  }
  return delimiters;
}

function pairDelimiters(delimiters: Delimiter[]) {
  // Resolve nearest closers once, including unmatched openers. No opener scans a suffix.
  let displayClose = -1;
  let inlineClose = -1;
  let nextInlineClose = -1;
  for (let index = delimiters.length - 1; index >= 0; index--) {
    const delimiter = delimiters[index];
    switch (delimiter.kind) {
      case "boundary":
        displayClose = inlineClose = nextInlineClose = -1;
        break;
      case "newline":
        inlineClose = nextInlineClose = -1;
        break;
      case "displayClose":
        displayClose = delimiter.index;
        break;
      case "inlineClose":
        nextInlineClose = inlineClose;
        inlineClose = delimiter.index;
        break;
      case "displayOpen":
        delimiter.close = displayClose;
        break;
      case "inlineOpen":
        delimiter.close = inlineClose === delimiter.index + 2 ? nextInlineClose : inlineClose;
        break;
    }
  }
}

/**
 * Literal ranges stop pairing (code/HTML). Opaque ranges hide delimiter tokens
 * (images/link metadata), but may be enclosed by a formula opened outside them.
 */
export function collectMathEdits(
  source: string,
  literal: readonly SourceRange[],
  opaque: readonly SourceRange[] = [],
) {
  const edits: SourceEdit[] = [];
  const math: SourceRange[] = [];
  const delimiters = collectDelimiters(source, literal, opaque);
  pairDelimiters(delimiters);
  let mathEnd = 0;
  for (const delimiter of delimiters) {
    if (delimiter.index < mathEnd) continue;
    if (delimiter.kind === "dollar") {
      edits.push({ start: delimiter.index, end: delimiter.index + 1, text: "\\$" });
    }
    if (delimiter.close === undefined || delimiter.close === -1) continue;
    const text = delimiter.kind === "displayOpen" ? "$$" : "$";
    edits.push(
      { start: delimiter.index, end: delimiter.index + 2, text },
      { start: delimiter.close, end: delimiter.close + 2, text },
    );
    mathEnd = delimiter.close + 2;
    math.push({ start: delimiter.index, end: mathEnd });
  }
  return { edits, math };
}
