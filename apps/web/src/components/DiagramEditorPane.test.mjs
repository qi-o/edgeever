import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./DiagramEditorPane.tsx", import.meta.url), "utf8");
const globalStyles = readFileSync(new URL("../styles/globals.css", import.meta.url), "utf8");

describe("diagram editor keyboard workflow", () => {
  test("supports direct node editing without routing keystrokes through the side panel", () => {
    expect(source).toContain('graph.on("node:dblclick"');
    expect(source).toContain('aria-label={t("diagram.editNode")}');
    expect(source).toContain('event.key === "Escape"');
  });

  test("keeps the standard mind-map sibling and child shortcuts", () => {
    expect(source).toContain('graph.bindKey("enter"');
    expect(source).toContain('insertNodeRef.current("sibling"');
    expect(source).toContain('graph.bindKey("tab"');
    expect(source).toContain('insertNodeRef.current("child"');
    expect(source).toContain("graph.cleanSelection();\n    graph.select(node);");
  });

  test("supports a complete flowchart keyboard workflow", () => {
    expect(source).toContain('openFlowQuickCreateRef.current = openFlowQuickCreate');
    expect(source).toContain('graph.bindKey("tab"');
    expect(source).toContain('graph.bindKey(["meta+d", "ctrl+d"]');
    expect(source).toContain('graph.startBatch("duplicate")');
    expect(source).toContain('graph.bindKey(["up", "down", "left", "right"');
    expect(source).toContain('graph.bindKey("0"');
    expect(source).toContain('graph.bindKey("1"');
    expect(source).toContain('"1": "process", "2": "decision", "3": "terminator"');
    expect(source).toContain('t("diagram.quickCreateShortcuts")');
  });

  test("continues from text editing into the flowchart node picker", () => {
    expect(source).toContain('else openFlowQuickCreateRef.current(editedNode)');
  });
});

describe("diagram editor canvas surface", () => {
  test("uses the common note header and capability-aware more menu", () => {
    expect(source).toContain('<span className="hidden truncate text-xs text-slate-400 sm:inline">{updatedLabel}</span>');
    expect(source).not.toContain('t("editor.updatedAt", { time: updatedLabel })');
    expect(source).toContain("onToggleDesktopFocusMode");
    expect(source).toContain("onOpenPreviousMemo");
    expect(source).toContain("onOpenNextMemo");
    expect(source).toContain('aria-label={t("editor.moreAria")}');
    expect(source).toContain('t("editor.versionHistory")');
    expect(source).toContain('"sharing.afterSync" : "sharing.action"');
    expect(source).toContain('t("templates.saveAsTemplate")');
    expect(source).toContain("<RevisionHistoryDialog");
    expect(source).toContain("<ShareMemoDialog");
  });

  test("autosaves diagram changes without a persistent save button", () => {
    expect(source).toContain("EDITOR_LOCAL_SAVE_DELAY_MS");
    expect(source).toContain("window.setTimeout(() => saveRef.current(), EDITOR_LOCAL_SAVE_DELAY_MS)");
    expect(source).toContain("nodeEditor !== null");
    expect(source).toContain("[dirty, dirtyVersion, editSessionReady, nodeEditor, readOnly, saveFailed, saving]");
    expect(source).toContain("!readOnly && saveFailed");
    expect(source).toContain('t("diagram.retrySave")');
    expect(source).not.toContain('<Save className="h-4 w-4" />');
  });

  test("uses a clean grid-free canvas for both diagram types", () => {
    expect(source).toContain("grid: false");
    expect(source).toContain("graph.clearGrid();");
    expect(source).not.toContain("diagramGrid");
    expect(source).not.toContain("graph.drawGrid");
  });

  test("uses straight flowchart edges and presents the content smaller at the left", () => {
    expect(source).toContain('connector: { name: kind === "mind-map" ? "smooth" : "normal" }');
    expect(source).toContain('router: "normal"');
    expect(source).not.toContain('name: "manhattan"');
    expect(source).toContain('maxScale: document.kind === "flowchart" ? 0.84 : 1');
    expect(source).toContain("fitDiagramContent(graph, document, containerRef.current);");
  });

  test("exposes flowchart-only connection handles with safe connection rules", () => {
    expect(source).toContain('kind === "flowchart" ? { ports:');
    expect(source).toContain("const FLOW_PORT_HIT_RADIUS = 14");
    expect(source).toContain("const FLOW_PORT_DOT_RADIUS = 7");
    expect(source).toContain('selector: "hitArea"');
    expect(source).toContain('className: "edgeever-flow-port-hit-area"');
    expect(source).toContain('className: "edgeever-flow-port-dot"');
    expect(source).toContain('pointerEvents: "all"');
    expect(source).toContain('pointerEvents: "none"');
    expect(globalStyles).toContain('[data-diagram-kind="flowchart"] .x6-widget-selection-box-node');
    expect(globalStyles).toContain("pointer-events: none !important");
    expect(source).toContain('allowPort: document.kind === "flowchart"');
    expect(source).toContain('allowBlank: document.kind === "flowchart"');
    expect(source).toContain("allowNode: false");
    expect(source).toContain("allowLoop: false");
    expect(source).toContain("allowMulti: false");
    expect(source).toContain("sourceCell.id !== targetCell.id");
    expect(source).toContain("data-diagram-kind={document.kind}");
  });

  test("shows connection handles only on selected flowchart nodes", () => {
    expect(globalStyles).toContain('.x6-node.edgeever-flow-node-active .edgeever-flow-port-dot');
    expect(globalStyles).toContain('.x6-port-body:hover .edgeever-flow-port-dot');
    expect(globalStyles).not.toContain('.x6-node.x6-node-selected .x6-port-body');
    expect(source).toContain('graph.on("node:selected"');
    expect(source).toContain('setFlowNodePortsActive(graph, node, true)');
    expect(source).toContain('graph.on("node:unselected"');
    expect(source).toContain('setFlowNodePortsActive(graph, node, false)');
    expect(source).toContain('port.style.setProperty("opacity", active ? "1" : "0", "important")');
    expect(source).toContain('port.style.setProperty("pointer-events", active ? "auto" : "none", "important")');
    expect(source).toContain('port.querySelector<SVGElement>(".edgeever-flow-port-dot") ?? port');
    expect(source).toContain('setOnlyFlowNodePortsActive(graph, node)');
    expect(source).toContain('graph.on("blank:click"');
    expect(source).toContain('setOnlyFlowNodePortsActive(graph);');
    expect(globalStyles).toContain("fill: var(--brand-green) !important");
    expect(globalStyles).toContain("pointer-events: none");
    expect(globalStyles).toContain("pointer-events: auto");
    expect(globalStyles).not.toContain('.edgeever-diagram-canvas[data-diagram-kind="flowchart"] .x6-node:hover .x6-port-body');
  });

  test("turns a connection dropped on blank canvas into a connected-node picker", () => {
    expect(source).toContain('graph.on("edge:connected"');
    expect(source).toContain('role="dialog"');
    expect(source).toContain("const FLOW_QUICK_CREATE_WIDTH = 330");
    expect(source).toContain('w-[330px] max-w-[calc(100%-24px)]');
    expect(source).toContain('min-w-0 flex-col gap-1 whitespace-nowrap px-2 text-xs');
    expect(source).toContain('t("diagram.quickCreateTitle")');
    expect(source).toContain('createConnectedFlowNode("process")');
    expect(source).toContain('createConnectedFlowNode("decision")');
    expect(source).toContain('createConnectedFlowNode("terminator")');
    expect(source).toContain("draftEdgeId: edge.id");
    expect(source).toContain("removeFlowDraftEdge");
    expect(source).toContain('addEventListener("pointerdown", handleFlowPointerDown, true)');
    expect(source).toContain('addEventListener("pointerup", handleFlowPointerUp, true)');
    expect(source).toContain("graph.clientToLocal(clientPoint)");
    expect(source).toContain('graph.startBatch("quick-create")');
  });

  test("repaints the graph when the application appearance changes", () => {
    expect(source).toContain("const { resolvedTheme } = useAppearanceTheme();");
    expect(source).toContain("applyGraphPalette(graph, themeRef.current, document.kind, resolvedTheme);");
    expect(source).toContain("data-diagram-appearance={resolvedTheme}");
    expect(source).toContain("<ThemeToggle />");
  });
});
