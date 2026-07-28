/**
 * Markdown → .docx rendering for knowledge assets.
 *
 * The agents write their concepts in markdown (## headings, bullets, numbered
 * steps, **bold** labels). Emitting those lines verbatim into a Paragraph left
 * the syntax visible in the downloaded document, so the markup is parsed here
 * and mapped to real Word structure.
 *
 * Deliberately NOT supported, because the corpus does not use them and guessing
 * would do more harm than good:
 *   - `_italics_` — underscores in this corpus are snake_case identifiers
 *     (source_file_url, key_visual), so honouring them would eat the text.
 *     Single-asterisk *italics* are honoured.
 *   - pipe tables and fenced code blocks — zero occurrences; they fall through
 *     as plain paragraphs rather than being half-rendered.
 */

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*•]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(-{3,}|_{3,}|\*{3,})\s*$/;

/** Inline spans, in precedence order: links, bold, italics, code. */
const INLINE =
  /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*|(?<!\*)\*([^*\n]+)\*(?!\*)|`([^`\n]+)`/g;

/** Undo markdown escapes once the markers have been consumed. */
const unescape = (s: string) => s.replace(/\\([*_`#>[\]])/g, "$1");

/** Plain text between spans: drop unpaired ** noise, keep lone * (could be literal). */
const plain = (s: string) => unescape(s.replace(/\*\*/g, ""));

type Docx = typeof import("docx");
type Run = InstanceType<Docx["TextRun"]> | InstanceType<Docx["ExternalHyperlink"]>;

/** Parse one line of inline markdown into docx runs. */
function inlineRuns(
  text: string,
  docx: Docx,
  base: { bold?: boolean; italics?: boolean } = {},
): Run[] {
  const { TextRun, ExternalHyperlink } = docx;
  const runs: Run[] = [];
  let cursor = 0;

  for (const m of text.matchAll(INLINE)) {
    const at = m.index!;
    if (at > cursor) {
      const before = plain(text.slice(cursor, at));
      if (before) runs.push(new TextRun({ ...base, text: before }));
    }
    const [, linkText, linkUrl, bold, italics, code] = m;
    if (linkUrl) {
      runs.push(
        new ExternalHyperlink({
          link: linkUrl,
          children: [new TextRun({ ...base, text: unescape(linkText), style: "Hyperlink" })],
        }),
      );
    } else if (bold !== undefined) {
      runs.push(new TextRun({ ...base, bold: true, text: unescape(bold) }));
    } else if (italics !== undefined) {
      runs.push(new TextRun({ ...base, italics: true, text: unescape(italics) }));
    } else if (code !== undefined) {
      runs.push(new TextRun({ ...base, font: "Courier New", text: unescape(code) }));
    }
    cursor = at + m[0].length;
  }

  if (cursor < text.length) {
    const rest = plain(text.slice(cursor));
    if (rest) runs.push(new TextRun({ ...base, text: rest }));
  }
  // A line that was pure markup (e.g. "**") must still yield a run.
  if (!runs.length) runs.push(new TextRun({ ...base, text: "" }));
  return runs;
}

const headingFor = (level: number, docx: Docx) =>
  [
    docx.HeadingLevel.HEADING_1,
    docx.HeadingLevel.HEADING_2,
    docx.HeadingLevel.HEADING_3,
    docx.HeadingLevel.HEADING_4,
    docx.HeadingLevel.HEADING_5,
    docx.HeadingLevel.HEADING_6,
  ][Math.min(level, 6) - 1];

/**
 * Convert a markdown body into docx paragraphs. Consecutive plain lines are kept
 * in one paragraph with soft breaks (a single newline is not a paragraph break in
 * markdown); blank lines separate paragraphs.
 */
export function markdownToParagraphs(
  markdown: string,
  docx: Docx,
): InstanceType<Docx["Paragraph"]>[] {
  const { Paragraph } = docx;
  const out: InstanceType<Docx["Paragraph"]>[] = [];
  const lines = (markdown || "").replace(/\r\n/g, "\n").split("\n");

  // Buffer of consecutive plain-text lines awaiting a paragraph break.
  let buffer: string[] = [];
  const flush = () => {
    if (!buffer.length) return;
    const children: Run[] = [];
    buffer.forEach((line, i) => {
      if (i > 0) children.push(new docx.TextRun({ break: 1 }));
      children.push(...inlineRuns(line, docx));
    });
    out.push(new Paragraph({ children, spacing: { after: 120 } }));
    buffer = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (!line.trim()) {
      flush();
      continue;
    }

    const rule = RULE.exec(line);
    if (rule) {
      flush();
      out.push(new Paragraph({ thematicBreak: true, spacing: { before: 160, after: 160 } }));
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      out.push(
        new Paragraph({
          heading: headingFor(heading[1].length, docx),
          children: inlineRuns(heading[2], docx),
          spacing: { before: 240, after: 120 },
        }),
      );
      continue;
    }

    const ordered = ORDERED.exec(line);
    if (ordered) {
      flush();
      const depth = Math.min(Math.floor(ordered[1].length / 2), 3);
      // The source numbers its own steps, so the literal number is preserved
      // (a docx numbering instance would restart/continue against the text).
      out.push(
        new Paragraph({
          indent: { left: 480 + depth * 360, hanging: 360 },
          spacing: { after: 80 },
          children: [
            new docx.TextRun({ text: `${ordered[2]}. ` }),
            ...inlineRuns(ordered[3], docx),
          ],
        }),
      );
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      flush();
      out.push(
        new Paragraph({
          bullet: { level: Math.min(Math.floor(bullet[1].length / 2), 3) },
          spacing: { after: 80 },
          children: inlineRuns(bullet[2], docx),
        }),
      );
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      flush();
      out.push(
        new Paragraph({
          indent: { left: 480 },
          spacing: { after: 80 },
          children: inlineRuns(quote[1], docx, { italics: true }),
        }),
      );
      continue;
    }

    buffer.push(line);
  }
  flush();

  return out;
}

/**
 * Build the concept .docx for a knowledge asset: title, "<type> · <brand>" line,
 * then the markdown body rendered as Word structure.
 */
export async function buildConceptDocx(input: {
  title: string;
  subtitle: string;
  markdown: string;
}): Promise<Buffer> {
  const docx = await import("docx");
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = docx;

  const body = markdownToParagraphs(input.markdown?.trim() || "Sin contenido.", docx);

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: input.title, heading: HeadingLevel.TITLE }),
          new Paragraph({
            spacing: { after: 240 },
            children: [new TextRun({ italics: true, text: input.subtitle })],
          }),
          ...body,
        ],
      },
    ],
  });

  return Packer.toBuffer(doc) as unknown as Buffer;
}
