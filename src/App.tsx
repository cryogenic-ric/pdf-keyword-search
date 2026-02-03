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

const SEP = "\u0000"; // sentinel between text nodes (unlikely to appear in PDFs)

const App = () => {
  const [file, setFile] = useState<FileLike>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [pageNumber, setPageNumber] = useState<number>(1);
  const [scale, setScale] = useState<number>(1.0);
  const [error, setError] = useState<string | null>(null);

  const [highlightTerm, setHighlightTerm] =
    useState<string>("behavioral health");

  // Utility: escape regex special characters
  const escapeRegExp = (s: any) =>
    s?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") ?? "";

  const buildCrossSpanRegex = (term: string) => {
    const trimmed = term.trim();
    if (!trimmed) return null;

    const chars = trimmed.split("");
    let corePattern = "";

    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (/\s/.test(ch)) {
        // spaces in query match one-or-more whitespace or separators
        corePattern += `(?:\\s|${SEP})+`;
      } else {
        corePattern += escapeRegExp(ch);
        if (i < chars.length - 1) corePattern += `(?:${SEP})*`;
      }
    }

    // "word-ish" boundaries (same as your intent)
    const pattern = `(^|[^A-Za-z0-9])(${corePattern})(?=$|[^A-Za-z0-9])`;
    return new RegExp(pattern, "gi");
  };

  const getTextLayer = () =>
    document.querySelector(
      ".react-pdf__Page__textContent",
    ) as HTMLElement | null;

  /**
   * Collect TEXT nodes only (preserves all nested spans/elements).
   */
  const collectTextNodes = (root: HTMLElement): Text[] => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node: any) {
        const v = node.nodeValue ?? "";
        // keep spaces too (PDF text often splits weirdly), just reject empty
        if (v.length === 0) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    } as any);

    const nodes: Text[] = [];
    let current: Node | null;
    while ((current = walker.nextNode())) nodes.push(current as Text);
    return nodes;
  };

  /**
   * Remove only our marks, restoring the DOM structure.
   */
  const removeCrossHighlights = (root: HTMLElement) => {
    root.querySelectorAll('mark[data-cross="true"]').forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;

      // unwrap
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);

      // merge adjacent text nodes back
      (parent as HTMLElement).normalize();
    });
  };

  /**
   * Wrap a range within a single Text node using splitText (safe + preserves nested spans).
   * Ranges are relative to the node's ORIGINAL text. Must run in descending order.
   */
  const wrapRangesInTextNode = (
    node: Text,
    ranges: Array<{ start: number; end: number }>,
  ) => {
    if (!ranges.length) return;

    // Sort descending so earlier splits don't invalidate later offsets
    const sorted = [...ranges].sort((a, b) => b.start - a.start);

    let current = node;

    for (const { start, end } of sorted) {
      const textLen = current.nodeValue?.length ?? 0;
      if (start < 0 || end > textLen || start >= end) continue;

      // split at end => [0..end) and [end..]
      current.splitText(end);
      // split at start => [0..start) and [start..end)
      const middle = current.splitText(start);

      const mark = document.createElement("mark");
      mark.className = "pdf-highlight";
      mark.dataset.cross = "true";

      const parent = middle.parentNode;
      if (!parent) continue;

      parent.insertBefore(mark, middle);
      mark.appendChild(middle);

      // after splitting, `current` remains the prefix [0..start)
      // so next (smaller) range still fits.
    }
  };

  const applyCrossSpanHighlight = (term: string) => {
    try {
      const layer = getTextLayer();
      if (!layer) return false;

      // always clear existing highlights first
      removeCrossHighlights(layer);

      const trimmed = term.trim();
      if (!trimmed) return true; // cleared

      const textNodes = collectTextNodes(layer);
      if (!textNodes.length) return false;

      // Snapshot current text contents (important: do this BEFORE any wrapping)
      const texts = textNodes.map((n) => n.nodeValue ?? "");
      const fullText = texts.join(SEP);

      const re = buildCrossSpanRegex(trimmed);
      if (!re) return false;

      // Find global matches in the virtual string
      const matches: Array<{ start: number; end: number }> = [];
      let m: RegExpExecArray | null;

      while ((m = re.exec(fullText))) {
        const prefixLen = m[1]?.length ?? 0;
        const coreLen = m[2]?.length ?? 0;
        const matchStart = m.index + prefixLen;
        const matchEnd = matchStart + coreLen;
        matches.push({ start: matchStart, end: matchEnd });
      }
      if (!matches.length) return false;

      // Build metadata: global offsets for each text node in the virtual string
      const meta = [];
      let cursor = 0;
      for (let i = 0; i < textNodes.length; i++) {
        const len = texts[i].length;
        meta.push({
          node: textNodes[i],
          start: cursor,
          end: cursor + len,
          len,
        });
        cursor += len + (i === textNodes.length - 1 ? 0 : 1); // +1 for SEP
      }

      // Map global matches -> per-node local ranges
      const perNodeRanges = new Map<
        Text,
        Array<{ start: number; end: number }>
      >();

      for (const { start, end } of matches) {
        for (const info of meta) {
          const overlapStart = Math.max(start, info.start);
          const overlapEnd = Math.min(end, info.end);

          if (overlapStart < overlapEnd) {
            const localStart = overlapStart - info.start;
            const localEnd = overlapEnd - info.start;

            const arr = perNodeRanges.get(info.node) ?? [];
            arr.push({ start: localStart, end: localEnd });
            perNodeRanges.set(info.node, arr);
          }
        }
      }

      // Apply wraps per text node (does NOT touch innerHTML, preserves nested spans)
      for (const [node, ranges] of perNodeRanges.entries()) {
        wrapRangesInTextNode(node, ranges);
      }

      return true;
    } catch (e) {
      console.warn("applyCrossSpanHighlight error", e);
      return false;
    }
  };

  const scrollToFirstHighlight = () => {
    try {
      const container = document.querySelector(
        ".pdf-viewer-area",
      ) as HTMLElement | null;
      if (!container) return false;

      const first = container.querySelector(
        ".pdf-highlight",
      ) as HTMLElement | null;
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

  const scheduleHighlightAndScroll = (term: string) => {
    if (term == null) return;

    let tries = 0;
    const maxTries = 20;

    const step = () => {
      const ok = applyCrossSpanHighlight(term);
      if (term.trim() && ok && scrollToFirstHighlight()) return;
      if (++tries < maxTries) setTimeout(step, 50);
    };

    setTimeout(step, 50);
  };

  useEffect(() => {
    scheduleHighlightAndScroll(highlightTerm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

      <div style={styles.searchBar}>
        <input
          type="text"
          placeholder="Search phrase..."
          value={highlightTerm}
          onChange={(e) => setHighlightTerm(e.target.value)}
          style={styles.searchInput}
        />
        {highlightTerm && (
          <button
            onClick={() => {
              setHighlightTerm("");
              scheduleHighlightAndScroll("");
            }}
            style={styles.clearSearch}
            title="Clear search"
          >
            ✕
          </button>
        )}
      </div>

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
  searchBar: {
    margin: "12px 0",
    display: "flex",
    alignItems: "center",
    position: "relative",
  },
  searchInput: {
    width: "100%",
    padding: "10px 40px 10px 16px",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.2)",
    background: "rgba(255,255,255,0.05)",
    color: "#fff",
    fontSize: "16px",
    outline: "none",
  },
  clearSearch: {
    position: "absolute",
    right: 12,
    background: "none",
    border: "none",
    color: "#aaa",
    cursor: "pointer",
    fontSize: "18px",
    padding: 0,
  },
};

export default App;
