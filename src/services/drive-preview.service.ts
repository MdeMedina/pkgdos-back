import fs from "node:fs";
import path from "node:path";
import sanitizeHtml from "sanitize-html";
import { env } from "../config/env.js";

/**
 * Document previews for the Drive. Anything the browser cannot display natively
 * (docx, xlsx, pptx, odt, rtf, doc, epub…) is converted to HTML by Apache Tika —
 * the same service the ingest pipeline already uses — and sanitized before it
 * reaches the UI. Images/PDF/plain text never come through here: the front-end
 * renders those directly from /uploads.
 */

/** MIME types (and extensions) we hand to Tika. Everything else gets the download fallback. */
const TIKA_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // docx
  "application/msword", // doc
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // xlsx
  "application/vnd.ms-excel", // xls
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // pptx
  "application/vnd.ms-powerpoint", // ppt
  "application/vnd.oasis.opendocument.text", // odt
  "application/vnd.oasis.opendocument.spreadsheet", // ods
  "application/vnd.oasis.opendocument.presentation", // odp
  "application/rtf",
  "text/rtf",
  "application/epub+zip",
]);

const TIKA_EXTS = new Set([
  ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt",
  ".odt", ".ods", ".odp", ".rtf", ".epub",
]);

/** Can this file be previewed as converted HTML? */
export function isConvertible(mime: string, name: string): boolean {
  if (TIKA_MIMES.has(mime)) return true;
  return TIKA_EXTS.has(path.extname(name).toLowerCase());
}

/**
 * Allowlist for Tika's output. Tika emits structural XHTML (headings, tables,
 * lists) plus <meta>/<script>-free head content, but it is still third-party
 * text derived from a user-uploaded file, so it is sanitized rather than trusted.
 */
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p", "br", "hr", "div", "span", "section",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "strong", "b", "em", "i", "u", "s", "sub", "sup",
    "ul", "ol", "li", "dl", "dt", "dd",
    "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td",
    "blockquote", "pre", "code", "a",
  ],
  allowedAttributes: {
    a: ["href", "title"],
    td: ["colspan", "rowspan"],
    th: ["colspan", "rowspan"],
    "*": ["class"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  // Tika wraps each page/slide in <div class="page">; keep the class, drop the rest.
  nonTextTags: ["style", "script", "textarea", "option", "noscript", "head"],
};

export class PreviewError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

/** Strip Tika's <html>/<head> wrapper so the UI embeds a fragment, not a document. */
function bodyFragment(html: string): string {
  const match = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return match ? match[1] : html;
}

/**
 * Turn Tika's list paragraphs into real lists.
 *
 * Tika renders every Word list item as `<p class="list_Paragraph">1. text</p>` — it
 * does not resolve the list format or the sequence, so bullets AND numbered lists
 * both come out as a literal "1." on every single item (verified against a docx
 * holding one of each). That synthetic marker is noise, so it is dropped and the
 * run becomes a <ul>. Consequence worth knowing: a genuinely numbered list in a
 * third-party document previews as bullets — better than "1. 1. 1.".
 *
 * Our own generated documents are unaffected in the other direction: their numbered
 * steps carry the real number as text in a plain <p>, so they keep 1., 2., 3.
 */
const LIST_PARAGRAPH = /<p([^>]*)\bclass="[^"]*list_Paragraph[^"]*"([^>]*)>([\s\S]*?)<\/p>/gi;
const SYNTHETIC_MARKER = /^(?:\s|&nbsp;)*(?:\d+|[a-z]|[ivx]+)\s*[.)](?:\s|&nbsp;)*/i;

function listifyTikaLists(html: string): string {
  const withItems = html.replace(LIST_PARAGRAPH, (_m, _a, _b, content: string) => {
    return `<li>${content.replace(SYNTHETIC_MARKER, "")}</li>`;
  });
  return (
    withItems
      // Wrap each run of consecutive items in a single <ul>.
      .replace(/(?:\s*<li>[\s\S]*?<\/li>)+/g, (run) => `<ul>${run}</ul>`)
      // Tika emits blank paragraphs for spacers and for borders it cannot draw
      // (a Word horizontal rule arrives as a self-closing <p/>); they add dead space.
      .replace(/<p[^>]*\/>|<p[^>]*>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>/gi, "")
  );
}

/**
 * Convert a stored file to sanitized preview HTML.
 * `storedUrl` is the DB `url` column ("/uploads/<name>"), resolved against UPLOADS_DIR —
 * only the basename is used, so the URL cannot escape the uploads directory.
 */
export async function renderPreviewHtml(storedUrl: string, name: string): Promise<string> {
  const filePath = path.join(env.UPLOADS_DIR, path.basename(storedUrl));
  if (!fs.existsSync(filePath)) {
    throw new PreviewError("The stored file is missing on disk", 404);
  }

  const buffer = await fs.promises.readFile(filePath);
  let res: Response;
  try {
    res = await fetch(`${env.TIKA_URL}/tika`, {
      method: "PUT",
      headers: {
        Accept: "text/html",
        "Content-Type": "application/octet-stream",
        // Lets Tika pick the right parser when the MIME sniffing is ambiguous.
        "Content-Disposition": `attachment; filename="${encodeURIComponent(name)}"`,
      },
      body: new Uint8Array(buffer),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err: any) {
    throw new PreviewError(`Preview service unreachable: ${err?.message ?? "unknown error"}`);
  }

  if (!res.ok) {
    throw new PreviewError(`Preview service returned ${res.status}`);
  }

  const raw = listifyTikaLists(bodyFragment(await res.text()));
  const clean = sanitizeHtml(raw, SANITIZE_OPTIONS).trim();
  if (!clean) {
    throw new PreviewError("This document has no extractable content", 422);
  }
  return clean;
}
