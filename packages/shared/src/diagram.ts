export const DIAGRAM_SCHEMA_VERSION = 1 as const;

export type DiagramKind = "mind-map" | "flowchart";
export type DiagramNodeShape = "topic" | "process" | "decision" | "terminator";
export type DiagramTheme = "brand" | "ocean" | "ink";

export type DiagramNode = {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  shape: DiagramNodeShape;
  parentId?: string;
};

export type DiagramEdge = {
  id: string;
  source: string;
  target: string;
  label?: string;
};

export type DiagramDocument = {
  schemaVersion: typeof DIAGRAM_SCHEMA_VERSION;
  kind: DiagramKind;
  theme?: DiagramTheme;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
};

const DIAGRAM_MARKER = "edgeever-diagram-v1";
const DIAGRAM_COMMENT = new RegExp(`<!--\\s*${DIAGRAM_MARKER}:([A-Za-z0-9_-]+)\\s*-->`);

const encodeBase64Url = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const decodeBase64Url = (value: string) => {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const parseNode = (value: unknown): DiagramNode | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const node = value as Record<string, unknown>;
  if (
    typeof node.id !== "string" || !node.id || typeof node.label !== "string"
    || !isFiniteNumber(node.x) || !isFiniteNumber(node.y)
    || !isFiniteNumber(node.width) || !isFiniteNumber(node.height)
    || !["topic", "process", "decision", "terminator"].includes(String(node.shape))
  ) return null;
  return {
    id: node.id,
    label: node.label,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    shape: node.shape as DiagramNodeShape,
    ...(typeof node.parentId === "string" && node.parentId ? { parentId: node.parentId } : {}),
  };
};

const parseEdge = (value: unknown): DiagramEdge | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const edge = value as Record<string, unknown>;
  if (typeof edge.id !== "string" || !edge.id || typeof edge.source !== "string" || typeof edge.target !== "string") return null;
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(typeof edge.label === "string" && edge.label ? { label: edge.label } : {}),
  };
};

export const parseDiagramDocument = (markdown: string | null | undefined): DiagramDocument | null => {
  const encoded = markdown?.match(DIAGRAM_COMMENT)?.[1];
  if (!encoded) return null;
  try {
    const value = JSON.parse(decodeBase64Url(encoded)) as Record<string, unknown>;
    if (value.schemaVersion !== DIAGRAM_SCHEMA_VERSION || (value.kind !== "mind-map" && value.kind !== "flowchart")) return null;
    if (
      !Array.isArray(value.nodes)
      || !Array.isArray(value.edges)
      || (value.theme !== undefined && !["brand", "ocean", "ink"].includes(String(value.theme)))
    ) return null;
    const nodes = value.nodes.map(parseNode);
    const edges = value.edges.map(parseEdge);
    if (nodes.some((node) => !node) || edges.some((edge) => !edge)) return null;
    const nodeIds = new Set((nodes as DiagramNode[]).map((node) => node.id));
    if (
      nodeIds.size !== nodes.length
      || (nodes as DiagramNode[]).some((node) => node.parentId && (node.parentId === node.id || !nodeIds.has(node.parentId)))
      || (edges as DiagramEdge[]).some((edge) => !nodeIds.has(edge.source) || !nodeIds.has(edge.target))
    ) return null;
    return {
      schemaVersion: DIAGRAM_SCHEMA_VERSION,
      kind: value.kind,
      ...(value.theme ? { theme: value.theme as DiagramTheme } : {}),
      nodes: nodes as DiagramNode[],
      edges: edges as DiagramEdge[],
    };
  } catch {
    return null;
  }
};

export const diagramFallbackMarkdown = (document: DiagramDocument) => {
  const title = document.kind === "mind-map" ? "思维导图" : "流程图";
  const connectedTargets = new Set(document.edges.map((edge) => edge.target));
  const orderedNodes = [
    ...document.nodes.filter((node) => !connectedTargets.has(node.id)),
    ...document.nodes.filter((node) => connectedTargets.has(node.id)),
  ];
  return [`# ${title}`, "", ...orderedNodes.map((node) => `- ${node.label.replace(/\s+/g, " ").trim() || "未命名节点"}`)].join("\n");
};

export const serializeDiagramDocument = (document: DiagramDocument) =>
  `${diagramFallbackMarkdown(document)}\n\n<!-- ${DIAGRAM_MARKER}:${encodeBase64Url(JSON.stringify(document))} -->`;

export const createDefaultDiagramDocument = (kind: DiagramKind): DiagramDocument => {
  if (kind === "mind-map") {
    return {
      schemaVersion: DIAGRAM_SCHEMA_VERSION,
      kind,
      nodes: [
        { id: "topic-root", label: "核心主题", x: 72, y: 150, width: 112, height: 42, shape: "topic" },
        { id: "topic-1", label: "分支主题", x: 256, y: 88, width: 92, height: 36, shape: "topic", parentId: "topic-root" },
        { id: "topic-2", label: "分支主题", x: 256, y: 153, width: 92, height: 36, shape: "topic", parentId: "topic-root" },
        { id: "topic-3", label: "分支主题", x: 256, y: 218, width: 92, height: 36, shape: "topic", parentId: "topic-root" },
      ],
      edges: [
        { id: "branch-1", source: "topic-root", target: "topic-1" },
        { id: "branch-2", source: "topic-root", target: "topic-2" },
        { id: "branch-3", source: "topic-root", target: "topic-3" },
      ],
    };
  }
  return {
    schemaVersion: DIAGRAM_SCHEMA_VERSION,
    kind,
    nodes: [
      { id: "flow-start", label: "开始", x: 80, y: 180, width: 104, height: 40, shape: "terminator" },
      { id: "flow-process", label: "处理步骤", x: 256, y: 180, width: 112, height: 40, shape: "process" },
      { id: "flow-end", label: "结束", x: 440, y: 180, width: 104, height: 40, shape: "terminator" },
    ],
    edges: [
      { id: "flow-edge-1", source: "flow-start", target: "flow-process" },
      { id: "flow-edge-2", source: "flow-process", target: "flow-end" },
    ],
  };
};
