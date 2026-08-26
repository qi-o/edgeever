import { PdfAttachment as BasePdfAttachment } from "@edgeever/shared";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useEffect, useState } from "react";
import { PdfViewer } from "@/components/pdf/PdfViewer";
import {
  PDF_PREVIEW_CHANGED_EVENT,
  PDF_PREVIEW_STORAGE_KEY,
  readPdfPreviewPreference,
  type PdfPreviewPreference,
} from "@/lib/pdf-preview-preference";

const PdfAttachmentNodeView = ({ node }: NodeViewProps) => {
  const url = typeof node.attrs.url === "string" ? node.attrs.url : "";
  const label = typeof node.attrs.label === "string" ? node.attrs.label : "PDF";
  const [preference, setPreference] = useState<PdfPreviewPreference>(readPdfPreviewPreference);

  useEffect(() => {
    const syncPreference = () => setPreference(readPdfPreviewPreference());
    const onPreferenceChanged = (event: Event) => {
      const detail = (event as CustomEvent<PdfPreviewPreference>).detail;
      setPreference(detail === "collapsed" ? "collapsed" : "expanded");
    };
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key === PDF_PREVIEW_STORAGE_KEY) syncPreference();
    };
    window.addEventListener(PDF_PREVIEW_CHANGED_EVENT, onPreferenceChanged);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(PDF_PREVIEW_CHANGED_EVENT, onPreferenceChanged);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return (
    <NodeViewWrapper as="span" className="edgeever-pdf-attachment-node" contentEditable={false}>
      <PdfViewer
        key={preference}
        url={url}
        label={label}
        defaultExpanded={preference === "expanded"}
      />
    </NodeViewWrapper>
  );
};

export const PdfAttachment = BasePdfAttachment.extend({
  addNodeView() {
    return ReactNodeViewRenderer(PdfAttachmentNodeView);
  },
});
