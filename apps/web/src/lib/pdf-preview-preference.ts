export type PdfPreviewPreference = "expanded" | "collapsed";

export const PDF_PREVIEW_STORAGE_KEY = "edgeever.pdfPreviewMode.v1";
export const PDF_PREVIEW_CHANGED_EVENT = "edgeever:pdf-preview-preference-changed";

export const resolvePdfPreviewPreference = (value: string | null): PdfPreviewPreference =>
  value === "collapsed" ? "collapsed" : "expanded";

export const readPdfPreviewPreference = (): PdfPreviewPreference => {
  try {
    return resolvePdfPreviewPreference(
      typeof window === "undefined" ? null : window.localStorage.getItem(PDF_PREVIEW_STORAGE_KEY),
    );
  } catch {
    return "expanded";
  }
};

export const writePdfPreviewPreference = (preference: PdfPreviewPreference) => {
  try {
    window.localStorage.setItem(PDF_PREVIEW_STORAGE_KEY, preference);
  } catch {
    // Local storage can be unavailable in private or restricted browser contexts.
  }
  window.dispatchEvent(new CustomEvent(PDF_PREVIEW_CHANGED_EVENT, { detail: preference }));
};
