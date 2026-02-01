import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { useDropzone } from "react-dropzone";

import "react-pdf/dist/esm/Page/AnnotationLayer.css";
import "react-pdf/dist/esm/Page/TextLayer.css";
import "./index.css";

// Configure the PDF.js worker for Vite builds
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url,
).toString();

type FileLike = File | null;

const App = () => {
  const [file, setFile] = useState<FileLike>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [pageNumber, setPageNumber] = useState<number>(1);
  const [scale, setScale] = useState<number>(1.0);
  const [error, setError] = useState<string | null>(null);

  const [highlightTerm] = useState<string | null>("amount");

  // Utility: escape regex special characters
  const escapeRegExp = (s: any) =>
    s?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") ?? "";

  // Utility: escape text for safe innerHTML injection when marking cross-span highlights
  const escapeHTML = (s: any) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  /*
   * Find all case-insensitive matches of term within text
   */

  // Apply highlighting for phrases that span multiple PDF text spans
  const SEP = "\u0000"; // sentinel between spans (unlikely to appear in PDFs)

  const buildCrossSpanRegex = (term: string) => {
    // 1. Escape the entire term so we treat it as literal chars initially
    // 2. We want to allow the "SEP" (span boundary) to occur optionally between any two characters,
    //    and we want to treat spaces in the query as matching one-or-more whitespace/separators in the text.

    const escaped = escapeRegExp(term.trim());
    if (!escaped) return null;

    const chars = term.trim().split("");
    let corePattern = "";

    for (let i = 0; i < chars.length; i++) {
      const char = chars[i];
      if (/\s/.test(char)) {
        // It's a whitespace in the query
        corePattern += `(?:\\s|${SEP})+`;
      } else {
        // It's a non-whitespace char
        corePattern += escapeRegExp(char);
        // Allow optional separator after it, unless it's the last char
        if (i < chars.length - 1) {
          corePattern += `(?:${SEP})*`;
        }
      }
    }

    // Wrap in whole-word boundaries.
    const pattern = `(^|[^A-Za-z0-9])(${corePattern})(?=$|[^A-Za-z0-9])`;
    return new RegExp(pattern, "gi");
  };

  const highlightTextNodes = (element: HTMLElement, pattern: any) => {
    // Convert to array because we will be adding new nodes (the <mark> tags)
    // which can mess up live NodeList iteration
    const children = Array.from(element.childNodes);

    children.forEach((node: ChildNode) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue;
        if (pattern.test(text)) {
          const wrapper = document.createElement("span");
          wrapper.innerHTML = (text ?? "").replace(
            pattern,
            (_match, pre, phrase, post) =>
              `${pre}<mark class="pdf-highlight">${phrase}</mark>${post}`,
          );

          // Replace the old text node with the new HTML structure
          while (wrapper.firstChild) {
            element.insertBefore(wrapper.firstChild, node);
          }
          element.removeChild(node);
        }
      } else if (
        node.nodeType === Node.ELEMENT_NODE &&
        node instanceof HTMLElement
      ) {
        // If it's a nested span/element, recurse into it
        highlightTextNodes(node, pattern);
      }
    });
  };

  const applyCrossSpanHighlight = (term: string | null) => {
    try {
      if (!term?.trim()) return false;

      const textLayer = document.querySelector(
        ".react-pdf__Page__textContent",
      ) as HTMLElement | null;
      if (!textLayer) return false;

      // Remove previous cross-span highlights
      textLayer.querySelectorAll('mark[data-cross="true"]').forEach((mark) => {
        mark.replaceWith(...mark.childNodes);
      });

      // Only target the actual text spans inside the text layer
      const spans = Array.from(textLayer.querySelectorAll("span"));
      if (!spans.length) return false;

      // check if full term in any of the spans
      for (const span of spans) {
        const spanText = span.textContent ?? "";
        const spanPattern = new RegExp(
          `(^|[^A-Za-z0-9])(${escapeRegExp(term.trim())})(?=$|[^A-Za-z0-9])`,
          "gi", // Added 'g' flag to catch multiple occurrences if needed
        );

        if (spanPattern.test(spanText)) {
          highlightTextNodes(span, spanPattern);
          return false; // Found match, stop processing
        }
      }

      const contents = spans.map((s) => s.textContent ?? "");

      // Build a virtual string that keeps a 1-char separator between spans.
      let fullText = "";
      for (let i = 0; i < contents.length; i++) {
        fullText += contents[i];
        if (i !== contents.length - 1) fullText += SEP;
      }

      const re = buildCrossSpanRegex(term);
      if (!re) return false;

      const matches: Array<{ start: number; end: number }> = [];
      let m: RegExpExecArray | null;

      while ((m = re.exec(fullText))) {
        const prefixLen = m[1] ? m[1].length : 0;
        const coreLen = m[2].length;
        const matchStart = m.index + prefixLen;
        const matchEnd = matchStart + coreLen;
        matches.push({ start: matchStart, end: matchEnd });
      }
      if (!matches.length) return false;

      // Map global indices back to spans
      let cursor = 0;
      for (let i = 0; i < spans.length; i++) {
        const span = spans[i];
        const spanText = contents[i];
        const spanStart = cursor;
        const spanEnd = cursor + spanText.length;

        let newHTML = "";
        let lastIndex = 0;

        for (const { start, end } of matches) {
          const overlapStart = Math.max(start, spanStart);
          const overlapEnd = Math.min(end, spanEnd);

          if (overlapStart < overlapEnd) {
            const localStart = overlapStart - spanStart;
            const localEnd = overlapEnd - spanStart;

            newHTML += escapeHTML(spanText.slice(lastIndex, localStart));
            newHTML += `<mark class="pdf-highlight" data-cross="true">${escapeHTML(
              spanText.slice(localStart, localEnd),
            )}</mark>`;
            lastIndex = localEnd;
          }
        }

        newHTML += escapeHTML(spanText.slice(lastIndex));

        if (newHTML !== escapeHTML(spanText)) {
          span.innerHTML = newHTML;
        }

        cursor = spanEnd + (i === spans.length - 1 ? 0 : 1);
      }
      return true;
    } catch (e) {
      console.warn("applyCrossSpanHighlight error", e);
      return false;
    }
  };

  const scrollToFirstHighlight = () => {
    try {
      const container = document.querySelector(".pdf-viewer-area");
      if (!container) return false;

      const first = container.querySelector(".pdf-highlight");
      if (!first) return false;

      const rect = first.getBoundingClientRect();
      const contRect = container.getBoundingClientRect();
      const top = rect.top - contRect.top + container.scrollTop;

      const targetTop = Math.max(
        0,
        top - container.clientHeight / 2 + rect.height / 2,
      );

      container.scrollTo({ top: targetTop, behavior: "smooth" });
      return true;
    } catch (e) {
      console.warn("scrollToFirstHighlight error", e);
      return false;
    }
  };

  const scheduleHighlightAndScroll = (term: any) => {
    if (!term) return;
    let tries = 0;
    const maxTries = 20;

    const step = () => {
      applyCrossSpanHighlight(term);
      if (scrollToFirstHighlight()) return;
      if (++tries < maxTries) setTimeout(step, 50);
    };
    setTimeout(step, 0);
  };

  useEffect(() => {
    scheduleHighlightAndScroll(highlightTerm);
  }, [highlightTerm, pageNumber, scale]);

  const onDrop = useCallback((accepted: File[]) => {
    const pdf = accepted.find((f) => f.type === "application/pdf");
    if (pdf) {
      setError(null);
      setFile(pdf);
      setPageNumber(1);
    } else {
      setError("Please drop a PDF file.");
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: { "application/pdf": [".pdf"] },
    multiple: false,
    onDrop,
  });

  const handleDocumentLoad = useCallback(
    ({ numPages: total }: { numPages: number }) => {
      setNumPages(total);
      setPageNumber(1);
    },
    [],
  );

  const canPrev = useMemo(() => !!file && pageNumber > 1, [file, pageNumber]);
  const canNext = useMemo(
    () => !!file && pageNumber < numPages,
    [file, numPages, pageNumber],
  );

  const changePage = (delta: number) => {
    setPageNumber((p) => Math.min(Math.max(p + delta, 1), numPages || 1));
  };

  const handleScale = (delta: number) => {
    setScale((s) => {
      const next = Number((s + delta).toFixed(2));
      return Math.min(Math.max(next, 0.5), 3);
    });
  };

  const handlePageInput = (value: string) => {
    const next = Number(value);
    if (!Number.isFinite(next)) return;
    setPageNumber(Math.min(Math.max(next, 1), numPages || 1));
  };

  return (
    <div style={styles.appShell}>
      <header style={styles.header}>
        <h1 style={styles.title}>PDF Search Viewer</h1>
        <p style={styles.subtitle}>
          Drop a PDF below and navigate with the controls.
        </p>
      </header>

      <section style={styles.dropZone} {...getRootProps()}>
        <input {...getInputProps()} />
        {isDragActive ? (
          <p>Drop the PDF here…</p>
        ) : file ? (
          <p>
            Loaded: <strong>{file.name}</strong>
          </p>
        ) : (
          <p>Drag & drop a PDF here, or click to select</p>
        )}
      </section>

      {error && <div style={styles.error}>{error}</div>}

      <div style={styles.controls}>
        <button
          onClick={() => changePage(-1)}
          disabled={!canPrev}
          style={styles.button}
        >
          ◀ Prev
        </button>
        <span style={styles.pageInfo}>
          Page{" "}
          <input
            type="number"
            min={1}
            max={numPages || 1}
            value={pageNumber}
            onChange={(e) => handlePageInput(e.target.value)}
            style={styles.pageInput}
            disabled={!file}
          />{" "}
          / {numPages || 0}
        </span>
        <button
          onClick={() => changePage(1)}
          disabled={!canNext}
          style={styles.button}
        >
          Next ▶
        </button>
        <span style={{ flex: 1 }} />
        <button
          onClick={() => handleScale(-0.1)}
          disabled={!file || scale <= 0.5}
          style={styles.button}
        >
          −
        </button>
        <span style={styles.zoomLabel}>{Math.round(scale * 100)}%</span>
        <button
          onClick={() => handleScale(0.1)}
          disabled={!file || scale >= 3}
          style={styles.button}
        >
          +
        </button>
      </div>

      <div style={styles.viewer} className="pdf-viewer-area">
        {file ? (
          <Document
            file={file}
            onLoadSuccess={handleDocumentLoad}
            onLoadError={(err) =>
              setError(err?.message || "Failed to load PDF")
            }
          >
            <Page
              pageNumber={Math.min(Math.max(pageNumber, 1), numPages ?? 1)}
              onRenderSuccess={() => scheduleHighlightAndScroll(highlightTerm)}
              scale={scale}
            />
          </Document>
        ) : (
          <div style={styles.placeholder}>No PDF loaded.</div>
        )}
      </div>
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  appShell: {
    maxWidth: 960,
    margin: "0 auto",
    padding: "32px 16px",
    color: "#f5f5f5",
  },
  header: { textAlign: "center", marginBottom: 24 },
  title: { margin: 0, fontSize: "28px", letterSpacing: "0.5px" },
  subtitle: { margin: "6px 0 0", color: "#d0d0d0" },
  dropZone: {
    border: "2px dashed #4c8bf5",
    borderRadius: 12,
    padding: "28px 16px",
    textAlign: "center",
    background: "rgba(255,255,255,0.03)",
    cursor: "pointer",
  },
  controls: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    margin: "18px 0",
    padding: "10px 12px",
    borderRadius: 12,
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.08)",
  },
  button: {
    padding: "8px 12px",
    borderRadius: 8,
    background: "#4c8bf5",
    color: "#fff",
    border: "none",
    cursor: "pointer",
    minWidth: 70,
    fontWeight: 600,
  },
  pageInfo: { display: "flex", alignItems: "center", gap: 8, fontSize: 14 },
  pageInput: {
    width: 70,
    padding: "6px 8px",
    borderRadius: 6,
    border: "1px solid rgba(255,255,255,0.2)",
    background: "rgba(0,0,0,0.2)",
    color: "#fff",
  },
  zoomLabel: { minWidth: 48, textAlign: "center" },
  viewer: {
    minHeight: 420,
    maxHeight: "72vh",
    overflow: "auto",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(0,0,0,0.4)",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    padding: 12,
  },
  placeholder: { color: "#cccccc" },
  error: { marginTop: 12, color: "#ff6b6b", fontWeight: 600 },
  highlight: {
    backgroundColor: "yellow",
    color: "inherit",
    padding: 0,
    margin: 0,
    lineHeight: "inherit",
    fontSize: "inherit",
    fontFamily: "inherit",
    verticalAlign: "baseline",
    display: "inline",

    /* avoid affecting positioning in some browsers */
    position: "relative",
    top: 0,
  },
};

export default App;
