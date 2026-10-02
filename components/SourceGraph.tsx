"use client";

import {
  useRef,
  useEffect,
  useState,
  useReducer,
  useMemo,
  useCallback,
  type CSSProperties,
} from "react";
import type {
  NodeObject,
  LinkObject,
  ForceGraphMethods,
} from "react-force-graph-2d";
import { forceCollide, forceX, forceY } from "d3-force";
import { Icon } from "@/components/Icon";
import { ProviderLogo, providerLogoImgSrc } from "@/components/ProviderLogo";
import {
  GRAPH_DEBOUNCING_DELAY_MS,
  GRAPH_MAX_NODES,
  providerLabel,
  providerLogoId,
} from "@/lib/constants";

// ── Types matching cortex backend TripletWithEvidence ──────────────
export interface Entity {
  name: string;
  type: string;
  namespace: string;
  entity_id: string;
  identifier: string | null;
  /** Source app the entity's evidence came from (e.g. "slack", "google").
   *  Empty/absent for plain document or web ingests. Drives the connector logo
   *  rendered in the node detail panel. */
  provider?: string | null;
  /** Source nodes only: `resolved` | `stub` | `placeholder`. A `relates_to`
   *  target that has not been ingested still exists as a node, so this marks
   *  what is actually retrievable. */
  hydration?: string;
}

export interface RelationEvidence {
  canonical_predicate: string;
  raw_predicate: string;
  context: string;
  confidence: number;
  temporal_details: string | null;
  timestamp: string;
  relationship_id: string;
  chunk_id: string | null;
  source_entity_id: string | null;
  target_entity_id: string | null;
  /** Set only on `present_in`, the one auxiliary edge with no stored edge
   *  behind it (collapsed from PRESENT_IN + HAS_CHUNK). */
  synthesized?: boolean;
}

export interface TripletWithEvidence {
  source: Entity;
  target: Entity;
  relations: RelationEvidence[];
  chunk_id: string;
  /** When set, indicates whether this triplet came from the knowledge graph or the memory graph. */
  _graphSource?: "knowledge" | "memory";
  /** A fan-out cap clipped this node's auxiliary edges. */
  truncated?: boolean;
  /** Internal: marks a triplet as belonging to the structural layer. Set by
   *  SourceGraph when merging `auxiliaryRelations`, never by the backend. */
  _auxiliary?: boolean;
}

export interface GraphRelationsResponse {
  relations: (TripletWithEvidence | null)[];
  /** Structural graph around the entity relations: Entity→Source
   *  presence, Source→Comment/Attachment, Actor→Source/Comment and Source→Source
   *  links. Same item shape as `relations`, so the two concatenate. */
  auxiliary_relations?: (TripletWithEvidence | null)[];
  /** An aggregate row ceiling clipped the auxiliary graph — distinct from
   *  `is_truncated`, which describes `relations` pagination only.
   *
   *  NOT currently emitted by the backend — there is no response-level
   *  auxiliary truncation flag, only the per-triplet `truncated` marker the
   *  fan-out caps set. Kept optional so a future backend can supply it, but
   *  never rely on it alone: use auxiliaryTruncated() below. */
  auxiliary_truncated?: boolean;
  is_truncated: boolean;
  next_cursor: number | null;
  success: boolean;
  message: string;
}

// ── Internal graph types ──
type GraphSourceKind = "knowledge" | "memory" | "both";

interface GNode extends NodeObject {
  id: string;
  label: string;
  val: number;
  /** Raw connection count (uncapped), including provenance edges. Drives node
   *  radius and the auxiliary pool's truncation order. */
  connectionCount: number;
  /** Connection count from EXTRACTED relations only. Entities are ranked on this
   *  rather than on `connectionCount`: the backend emits up to 20 `present_in`
   *  edges per entity, which is typically far above its real graph degree, so
   *  ranking on the combined count selects the most-MENTIONED entities instead
   *  of the most-connected — and makes the graph page keep a different entity
   *  set than the query page for identical data. */
  kgConnectionCount: number;
  color?: string;
  type?: string;
  entity_id?: string;
  namespace?: string;
  identifier?: string | null;
  /** Originating connector provider slug (see Entity.provider). Used to render
   *  the brand logo in the node detail panel. */
  provider?: string;
  /** Tracks whether this node came from knowledge, memory, or both graphs. */
  graphSource?: GraphSourceKind;
  /** Connector logo URL to paint inside the node, resolved from the provider. */
  logoSrc?: string | null;
  /** Structural node (Source/Comment/Attachment/Actor) rather than an extracted
   *  entity. Painted in the auxiliary palette and hidden when the layer is off. */
  isAuxiliary?: boolean;
  /** Source-node hydration; drives the "not ingested" treatment. */
  hydration?: string;
}

interface GLink extends LinkObject {
  source: string;
  target: string;
  label: string;
  color?: string;
  curvature?: number;
  context?: string;
  temporal_details?: string | null;
  graphSource?: GraphSourceKind;
  /** Structural edge (present_in / has_comment / …) rather than an extracted
   *  relation. Drawn dashed so provenance never reads as an extracted fact. */
  isAuxiliary?: boolean;
  /** When the graph recorded the edge. NOT shown for synthesized edges — see
   *  `synthesized`. */
  timestamp?: string;
  /** No stored edge behind this one. Only `present_in` sets it: that edge is
   *  derived by collapsing Entity-PRESENT_IN->Chunk-HAS_CHUNK->Source. Its
   *  `timestamp` is therefore meaningless — the backend's formatTimestamp maps a
   *  NULL created_at to time.Now(), so it reads as the moment of the request and
   *  changes on every refresh. */
  synthesized?: boolean;
}

const BASE_NODE_RADIUS = 5;
const MAX_NODE_RADIUS = 14;
const MIN_NODE_HIT_RADIUS = 18;

// Connector logo images keyed by URL. Shared across every node paint so each
// <img> is created and decoded once rather than on every animation frame. SVGs
// are same-origin (public dir), so no CORS handling is needed.
const logoImageCache = new Map<string, HTMLImageElement>();

function getLogoImage(src: string): HTMLImageElement {
  let img = logoImageCache.get(src);
  if (!img) {
    img = new Image();
    img.src = src;
    logoImageCache.set(src, img);
  }
  return img;
}
// Node dots are painted in SCREEN space (constant pixel size regardless of
// zoom), so they never collapse to sub-pixel when the camera zooms out to fit a
// large graph. These are pixel radii, not graph-space radii.
const NODE_PIXEL_RADIUS_BASE = 14;
const NODE_PIXEL_RADIUS_PER_DEGREE = 1.6;
const NODE_PIXEL_RADIUS_MAX = 30;
// Nodes are painted in screen space, but we let their size track the zoom so they
// grow/shrink together with the (graph-space) edges as the user pinch-zooms —
// otherwise zooming in makes the constant-size nodes look ever smaller next to
// the expanding edges. NODE_ZOOM_REF is the zoom at which a node renders at its
// nominal getNodePixelRadius size; the scale factor is clamped so nodes never
// vanish when zoomed all the way out nor balloon when zoomed all the way in.
// The MIN sits below 1 so a zoomed-out fit-whole view shrinks the dots with the
// graph instead of keeping them at full nominal size, which made a fitted large
// graph read as a wall of oversized circles.
const NODE_ZOOM_REF = 1.45;
const NODE_ZOOM_SCALE_MIN = 0.5;
const NODE_ZOOM_SCALE_MAX = 3;
const NODE_PIXEL_HIT_PADDING = 6;
const NODE_PIXEL_SELECTED_BOOST = 1.7;
const NODE_PIXEL_HOVER_RING_OFFSET = 4;
const NODE_PIXEL_SELECTED_BRACKET_OFFSET = 6;
const NODE_LABEL_OFFSET_PX = 6;

// ── HydraDB graph palette (matches the Nish reference theme) ──────────
// One orange per view drives all highlight states; entities are grey, memory
// is the brand yellow, knowledge nodes read as hollow rings. Canvas paint can't
// resolve CSS vars, so these are the literal token values.
const COLOR_ENTITY = "#888888"; // entity — solid grey
const COLOR_MEMORY = "#ffc423"; // memory — brand yellow (--highlight)
const COLOR_LINK = "#5a5a5a"; // resting edge — readable grey, not near-black
const COLOR_LINK_DIM = "rgba(90,90,90,0.38)"; // edges dimmed while something is active
const COLOR_ACCENT = "#ececec"; // --accent — focus / hover highlight
const COLOR_ACCENT_2 = "#ffffff"; // --accent-2 — highlighted relation text
const COLOR_LABEL = "#808080"; // node + relation label text (--fg-3)
const COLOR_LABEL_BG = "#141414"; // relation label box fill
const COLOR_LABEL_BORDER = "#3a3a3a"; // relation label box border (--line-2)

type NodeKind = "entity" | "memory" | "knowledge";

function mergeGraphSource(
  existing: GraphSourceKind | undefined,
  incoming: GraphSourceKind | undefined,
): GraphSourceKind {
  if (!incoming) return existing || "knowledge";
  if (!existing || existing === incoming) return incoming;
  // Any mismatch (e.g. knowledge+memory, or anything+both) → "both"
  return "both";
}

/** Map the backend graphSource onto the reference's three visual node kinds. */
function nodeKindFor(graphSource: GraphSourceKind | undefined): NodeKind {
  if (graphSource === "memory") return "memory";
  if (graphSource === "both") return "knowledge";
  return "entity";
}

/** Representative dot colour for legends / info-panel swatches. */
function nodeDotColor(graphSource: GraphSourceKind | undefined): string {
  return graphSource === "memory" ? COLOR_MEMORY : COLOR_ENTITY;
}

// ── Auxiliary (structural) layer ──
// Source/Comment/Attachment/Actor nodes and the edges between them describe
// PROVENANCE, not extracted knowledge. They get their own hues, well away from
// the entity/memory palette, so a reader never mistakes "this was mentioned in
// that message" for "the model extracted this fact".
// Orange, and clear of the white focus accent: hover draws a ring, the same
// shape a structural node uses for its kind, so the two must never be
// confusable.
const COLOR_AUX_SOURCE = "#E07B39";
const COLOR_AUX_COMMENT = "#4F8DB3";
const COLOR_AUX_ATTACHMENT = "#6E8B5A";
const COLOR_AUX_ACTOR = "#9B6BA8";
const COLOR_AUX_LINK = "#8A7A55";
/** A relates_to target that is referenced but not ingested — broken ring. */
const COLOR_AUX_UNRESOLVED = "#8A8A8A";
/** Body of every structural node. Deliberately near the canvas ground so the
 *  coloured ring, not the fill, is what the eye reads. */
const COLOR_AUX_BODY = "#1c1c1c";

/** The structural node types. Exported because callers filtering the auxiliary
 *  layer need to tell a scaffold node from an extracted entity, and a second
 *  copy of this set would drift. */
export const AUX_NODE_TYPES = new Set([
  "SOURCE",
  "COMMENT",
  "ATTACHMENT",
  "ACTOR",
]);

/** Share of the node budget reserved for extracted entities when the provenance
 *  layer is on. Structural nodes outrank entities on raw degree, so without a
 *  reserved share they would take the whole canvas. */
const AUX_ENTITY_BUDGET_SHARE = 0.6;

/**
 * Whether a structural node genuinely has nothing behind it to open.
 *
 * The backend reports three hydration states, and only two of them are
 * trustworthy here. `placeholder` means the Source carries no source_id at all,
 * which is unambiguous. `stub` is inferred from a MISSING app_provider — but
 * app_provider is only written when the ingest had a canonical app source, so
 * an ordinary direct/API/memory ingest is indistinguishable from a genuinely
 * un-ingested RELATES_TO target. Treating `stub` as unresolved greys out real,
 * fully-ingested messages and counts them under a legend row that states, in
 * words, that they were never ingested. Believe `placeholder` only.
 */
function isUnresolvedSource(hydration?: string): boolean {
  return hydration === "placeholder";
}

function auxNodeColor(type: string | undefined, hydration?: string): string {
  if (isUnresolvedSource(hydration)) return COLOR_AUX_UNRESOLVED;
  switch (type) {
    case "SOURCE":
      return COLOR_AUX_SOURCE;
    case "COMMENT":
      return COLOR_AUX_COMMENT;
    case "ATTACHMENT":
      return COLOR_AUX_ATTACHMENT;
    case "ACTOR":
      return COLOR_AUX_ACTOR;
    default:
      return COLOR_AUX_LINK;
  }
}

/** Legend rows for the structural layer, in the order they read best:
 *  where a fact came from, then what hangs off it, then who touched it. */
/**
 * Whether the provenance layer on screen is incomplete.
 *
 * The backend bounds auxiliary fan-out per node (20 present_in per entity, 50
 * rows per source, 25 relates_to per source) and marks each affected triplet
 * with `truncated`. There is no response-level flag; reading a
 * `auxiliary_truncated` field off the response returns undefined every time, so
 * a disclosure driven by it never fires and a capped layer is shown as if it
 * were complete.
 */
export function auxiliaryTruncated(
  auxiliaryRelations: (TripletWithEvidence | null)[] | undefined,
  responseFlag?: boolean,
): boolean {
  if (responseFlag) return true;
  return (auxiliaryRelations || []).some((t) => t?.truncated);
}

/**
 * Restrict the provenance layer to what the relation filter left standing.
 *
 * An auxiliary triplet's non-structural endpoint is an ordinary Entity, and
 * SourceGraph builds it as a normal entity node. Passing the layer unfiltered
 * therefore re-adds every entity that has provenance, attached by a "mentioned
 * in" edge, right after the filter removed its relations.
 *
 * The two obvious rules are both wrong, which is why this is a function with
 * tests rather than a predicate inline in the page:
 *
 *   "keep structural-to-structural edges unconditionally" leaves the scaffold of
 *   a filtered-out entity floating — its Source, comments, attachments and
 *   people — and nothing downstream removes it, because the canvas budget's
 *   attachment gate only runs when the graph EXCEEDS maxNodes and a filtered
 *   graph is normally under it.
 *
 *   "keep anything reachable from a surviving entity" re-admits the filtered
 *   entities themselves: Sources are shared, so the walk goes
 *   surviving -> Source -> filtered and comes back with what the filter removed.
 *
 * So the walk stops at structural nodes, and an edge is kept only when BOTH
 * endpoints are admissible — a structural endpoint must be reachable, an entity
 * endpoint must have survived the filter itself.
 */
export function filterAuxiliaryToSurviving(
  auxRelations: TripletWithEvidence[],
  filteredRelations: TripletWithEvidence[],
): TripletWithEvidence[] {
  const surviving = new Set<string>();
  for (const t of filteredRelations) {
    if (t.source.entity_id) surviving.add(t.source.entity_id);
    if (t.target.entity_id) surviving.add(t.target.entity_id);
  }

  const structural = new Set<string>();
  const adjacency = new Map<string, string[]>();
  for (const t of auxRelations) {
    for (const e of [t.source, t.target]) {
      if (e.entity_id && AUX_NODE_TYPES.has(e.type)) structural.add(e.entity_id);
    }
    const a = t.source.entity_id;
    const b = t.target.entity_id;
    if (!a || !b) continue;
    if (!adjacency.has(a)) adjacency.set(a, []);
    if (!adjacency.has(b)) adjacency.set(b, []);
    adjacency.get(a)!.push(b);
    adjacency.get(b)!.push(a);
  }

  const reachable = new Set(surviving);
  const queue = [...surviving];
  while (queue.length) {
    for (const next of adjacency.get(queue.pop()!) || []) {
      // Structural only: re-entering an entity is what pulled filtered ones back.
      if (reachable.has(next) || !structural.has(next)) continue;
      reachable.add(next);
      queue.push(next);
    }
  }

  const admissible = (e: Entity) =>
    AUX_NODE_TYPES.has(e.type) ? reachable.has(e.entity_id) : surviving.has(e.entity_id);
  return auxRelations.filter((t) => admissible(t.source) && admissible(t.target));
}

/** Detail-panel heading per structural kind. */
const AUX_DETAIL_TITLES: Record<string, string> = {
  SOURCE: "Source",
  COMMENT: "Comment",
  ATTACHMENT: "Attachment",
  ACTOR: "Person",
};

/** Wording for a node whose own name property is absent — see entityDisplayLabel. */
const AUX_FALLBACK_LABELS: Record<string, string> = {
  SOURCE: "source",
  COMMENT: "comment",
  ATTACHMENT: "attachment",
  ACTOR: "person",
};

const AUX_LEGEND_ROWS: { type: string; label: string; color: string }[] = [
  { type: "SOURCE", label: "sources", color: COLOR_AUX_SOURCE },
  { type: "COMMENT", label: "comments", color: COLOR_AUX_COMMENT },
  { type: "ATTACHMENT", label: "attachments", color: COLOR_AUX_ATTACHMENT },
  { type: "ACTOR", label: "people", color: COLOR_AUX_ACTOR },
];

/** Human labels for the structural predicates the backend emits. */
const AUX_PREDICATE_LABELS: Record<string, string> = {
  present_in: "mentioned in",
  has_comment: "has comment",
  has_attachment: "has attachment",
  acted_on: "acted on",
  authored_comment: "authored",
  relates_to: "related to",
};

/** Predicates whose discriminating value rides in `raw_predicate` rather than in
 *  the canonical kind: ACTED_ON carries the actor's role (author / editor /
 *  recipient …) and RELATES_TO carries the link type (reply_to, forwarded_from
 *  …). Labelling from the canonical predicate alone renders every one of them
 *  identically and throws that away. */
const AUX_RAW_PREDICATE_KINDS = new Set(["acted_on", "relates_to"]);

/** `reply_to` -> `replied to`-ish: good enough for a graph edge label. */
function humanizePredicate(raw: string): string {
  // A raw value of "___" or "--" collapses to "" here; the caller treats an
  // empty return as "no usable wording" rather than rendering it.
  return raw.replace(/[_-]+/g, " ").trim().toLowerCase();
}

/** Last-resort wording, per edge kind, so no edge can draw without a label. */
const FALLBACK_PREDICATE = { aux: "linked to", extracted: "related to" };

/**
 * The label for any edge, guaranteed non-empty.
 *
 * `canonical_predicate` is empty in none of 54,333 sampled relations, but
 * nothing in the type or the pipeline guarantees that, and an empty label draws
 * a bare line on the canvas and an empty chip in the detail panel -- which reads
 * as a rendering failure rather than as missing data. Empirically absent is not
 * the same as impossible, so this closes it structurally.
 */
/**
 * Cap a graph label length.
 *
 * Labels come from indexed content that other people write. The collision math
 * and text rendering scale with label length, so one pathological label (tens
 * of thousands of characters) would wreck the layout. No real node or relation
 * name is this long.
 */
const MAX_LABEL_CHARS = 120;
export function clampLabel(s: string): string {
  return s.length > MAX_LABEL_CHARS ? s.slice(0, MAX_LABEL_CHARS - 1) + "…" : s;
}

export function linkLabel(rel: RelationEvidence, aux: boolean): string {
  const chosen = (aux ? auxLinkLabel(rel) : rel.canonical_predicate) || "";
  if (chosen.trim()) return clampLabel(chosen.trim());
  // Not `humanized || raw`: a punctuation-only raw ("___", "--") humanizes to
  // nothing, and falling back to the raw string would put literal underscores on
  // the canvas. Not-empty is not the bar; readable is.
  const humanized = humanizePredicate(rel.raw_predicate || "");
  if (humanized) return clampLabel(humanized);
  return aux ? FALLBACK_PREDICATE.aux : FALLBACK_PREDICATE.extracted;
}

export function auxLinkLabel(rel: RelationEvidence): string {
  const canonical = rel.canonical_predicate;
  const raw = (rel.raw_predicate || "").trim();
  if (
    AUX_RAW_PREDICATE_KINDS.has(canonical) &&
    raw &&
    raw !== canonical &&
    raw.toLowerCase() !== canonical.toLowerCase()
  ) {
    return humanizePredicate(raw);
  }
  return AUX_PREDICATE_LABELS[canonical] || canonical;
}

const GRAPH_SOURCE_LABELS: Record<GraphSourceKind, string> = {
  knowledge: "Knowledge",
  memory: "Memory",
  both: "Knowledge & Memory",
};
const EXPANDED_LINK_DISTANCE = 68;
const COMPACT_LINK_DISTANCE = 56;
const MIN_LABEL_COLLISION_RADIUS = 38;
const LABEL_COLLISION_CHAR_WIDTH = 8;
const LINK_LABEL_COLLISION_CHAR_WIDTH = 7;
const NODE_LABEL_FONT_SIZE = 14;
const LINK_LABEL_FONT_SIZE = 10;
const MIN_LINK_LABEL_SCREEN_LENGTH = 36;
const LINK_LABEL_SCREEN_PADDING = 28;
// Below this zoom level, ordinary node labels are hidden to avoid label soup
// on a zoomed-out whole-graph view. Active/hovered/selected nodes always keep
// their label regardless of zoom.
const NODE_LABEL_MIN_ZOOM = 0.55;
const HIDDEN_LABEL_NODE_RADIUS_SCALE = 1.7;
const HIDDEN_LABEL_NODE_RADIUS_BOOST = 2;
const MAX_HIDDEN_LABEL_NODE_RADIUS = 14;
// Cap the auto-fit zoom. zoomToFit picks the zoom that fits the WHOLE graph in
// the viewport, which on a large graph is a tiny, cramped hairball. The MIN
// floor forces the camera to stay zoomed-in enough that nodes (drawn in
// screen-space, constant pixels) and their labels are comfortably legible by
// default — we deliberately show a legible PORTION of a large graph, not the
// whole thing (the islands are now gathered near center by gravity, so a small
// pan reveals them). The user can still zoom out manually. MAX prevents tiny
// graphs from over-zooming.
// Keep MAX close to MIN so the default zoom lands in a tight band regardless of
// graph size. Small graphs (e.g. a single source's KG/memory view) otherwise fit
// at a much higher zoom than the large "complete brain" graph, which — because
// nodes and label fonts are drawn at a constant pixel size while edges scale with
// zoom — makes their edges look too long relative to the circles/text. A tight
// band makes every graph read at the same comfortable scale.
const FIT_MAX_ZOOM = 1.85;
const FIT_MIN_ZOOM = 1.5;

// Delay before the graph is faded into view. Building graphData, seeding the
// force simulation, and the first auto-fit passes all happen synchronously on
// mount; showing the canvas immediately makes the graph "snap" into place as
// that math resolves. Holding it hidden for a beat and easing it in lets the
// initial layout settle off-screen, so it appears smoothly instead.
//
// The delay scales with node count: a bigger graph has more bodies for the
// force simulation to push apart, so it takes longer to stop visibly moving.
// A fixed delay would fade a large graph in mid-settle (still snappy) while
// over-waiting on a tiny one. delay = clamp(MIN + nodes * PER_NODE, MIN, MAX).
const GRAPH_FADE_IN_MIN_DELAY_MS = 300;
const GRAPH_FADE_IN_MAX_DELAY_MS = 1800;
const GRAPH_FADE_IN_MS_PER_NODE = 5;
const GRAPH_FADE_IN_DURATION_MS = 320;

function graphFadeInDelay(nodeCount: number): number {
  return Math.min(
    GRAPH_FADE_IN_MAX_DELAY_MS,
    GRAPH_FADE_IN_MIN_DELAY_MS + nodeCount * GRAPH_FADE_IN_MS_PER_NODE,
  );
}

const GRAPH_PANEL_STYLE = {
  background: "var(--bg-elev)",
  backdropFilter: "blur(10px)",
  border: "1px solid var(--line-2)",
  boxShadow: "0 10px 28px rgba(0,0,0,0.22)",
} satisfies CSSProperties;

const GRAPH_CONTROL_BUTTON_STYLE = {
  background: "var(--bg-elev)",
  borderColor: "var(--line-2)",
  color: "var(--fg)",
  fontSize: 11,
  padding: "4px 10px",
} satisfies CSSProperties;

function getLinkEndpointId(ep: string | NodeObject): string | null {
  if (typeof ep === "string") return ep;
  return typeof ep.id === "string" ? ep.id : null;
}

function getNodeCollisionRadius(node: NodeObject): number {
  const graphNode = node as GNode;
  // Labels are centred BELOW the node, so only a fraction of the label width
  // needs clearance to keep neighbouring labels from colliding — using the full
  // width (as before) inflated every gap to ~260px and made the graph sparse.
  return Math.max(
    MIN_LABEL_COLLISION_RADIUS,
    graphNode.label.length * LABEL_COLLISION_CHAR_WIDTH * 0.45 +
      graphNode.val +
      12,
  );
}

function getVisibleNodeRadius(node: GNode, showNodeLabels: boolean): number {
  if (showNodeLabels) return node.val;
  return Math.min(
    node.val * HIDDEN_LABEL_NODE_RADIUS_SCALE + HIDDEN_LABEL_NODE_RADIUS_BOOST,
    MAX_HIDDEN_LABEL_NODE_RADIUS,
  );
}

/**
 * Screen-space pixel radius for a node — constant regardless of zoom, so nodes
 * stay legible when the camera zooms out to fit a large graph. Hubs (higher
 * degree) render larger, clamped to a sane max.
 */
function getNodePixelRadius(node: GNode): number {
  const degree = node.connectionCount ?? 1;
  return Math.min(
    NODE_PIXEL_RADIUS_BASE + degree * NODE_PIXEL_RADIUS_PER_DEGREE,
    NODE_PIXEL_RADIUS_MAX,
  );
}

/** Screen-space node radius scaled by the current zoom (clamped), so nodes
 *  grow and shrink with the edges instead of staying a fixed pixel size. */
function getNodeScaledRadius(node: GNode, globalScale: number): number {
  const zoomFactor = Math.min(
    NODE_ZOOM_SCALE_MAX,
    Math.max(NODE_ZOOM_SCALE_MIN, globalScale / NODE_ZOOM_REF),
  );
  return getNodePixelRadius(node) * zoomFactor;
}

function getGraphNodeLabel(
  endpoint: string | NodeObject,
  nodeById: Map<string, GNode>,
): string {
  if (
    typeof endpoint === "object" &&
    "label" in endpoint &&
    typeof endpoint.label === "string"
  ) {
    return endpoint.label;
  }
  return nodeById.get(getLinkEndpointId(endpoint) || "")?.label || "";
}

function getGraphLinkDistance(
  link: LinkObject,
  nodeById: Map<string, GNode>,
  isExpandedView: boolean,
  showNodeLabels: boolean,
  showRelationLabels: boolean,
): number {
  const graphLink = link as GLink;
  const defaultDistance = isExpandedView
    ? EXPANDED_LINK_DISTANCE
    : COMPACT_LINK_DISTANCE;
  const baseDistance =
    defaultDistance * (showRelationLabels ? 1 : showNodeLabels ? 0.8 : 0.55);
  const sourceLabelWidth = showNodeLabels
    ? getGraphNodeLabel(graphLink.source as string | NodeObject, nodeById)
        .length * LABEL_COLLISION_CHAR_WIDTH
    : 0;
  const targetLabelWidth = showNodeLabels
    ? getGraphNodeLabel(graphLink.target as string | NodeObject, nodeById)
        .length * LABEL_COLLISION_CHAR_WIDTH
    : 0;
  const relationLabelWidth = showRelationLabels
    ? graphLink.label.length * LINK_LABEL_COLLISION_CHAR_WIDTH
    : 0;
  // Node labels sit below their nodes, not along the edge, so they need only a
  // little clearance along the link axis; the relation label (drawn at the edge
  // midpoint) is what actually needs room. Keeping this additive term small lets
  // baseDistance drive a compact, readable layout instead of stretching edges.
  const labelDistance =
    (sourceLabelWidth + targetLabelWidth) * 0.1 +
    relationLabelWidth * 0.35 +
    (isExpandedView ? 10 : 8);

  return Math.max(baseDistance, labelDistance);
}

/**
 * Build a semantic merge key for an entity. When the graph contains mixed
 * sources (knowledge + memory) the same real-world entity will usually
 * arrive with different `entity_id` values (one per backend subtenant).
 * To surface "Both" nodes we key by a normalised semantic identity when
 * the relation set is mixed, falling back to `entity_id` for single-source
 * graphs where the IDs are already correct.
 */
export function entityMergeKey(entity: Entity, mixed: boolean): string {
  if (!mixed) return entity.entity_id;
  // Prefer namespace:type:identifier when an identifier is present (most
  // reliable cross-graph identity). Otherwise fall back to lower-cased name
  // scoped to namespace+type so collisions stay unlikely.
  if (entity.identifier) {
    return `${entity.namespace}:${entity.type}:${entity.identifier}`.toLowerCase();
  }
  if (entity.name) {
    return `${entity.namespace}:${entity.type}:${entity.name}`.toLowerCase();
  }
  // Neither is present. Structural nodes take their name from a provider-specific
  // property that is simply absent on some ingests (a Source with no
  // app_external_id, an Actor with no email), so this is reachable in normal
  // data, not a corrupt-row case. Without this branch every such node of a given
  // type keys to the same `namespace:type:` string and they all merge into ONE
  // node — distinct messages drawn as a single point, with a degree inflated by
  // the merge that then wins the canvas budget over real entities.
  return entity.entity_id;
}

/**
 * Human-readable label for a node.
 *
 * `name` is populated from a different property per node type — app_external_id
 * for Source, email for Actor, file_name for Attachment, author_display for
 * Comment — and every one of them is optional. When it is missing the node still
 * exists and still has edges; only its label is empty, which renders as an
 * unlabelled dot on the canvas, a blank row in node search, and an anonymous
 * detail panel. Fall back to something that at least identifies the node.
 */
export function entityDisplayLabel(entity: Entity): string {
  const name = (entity.name || "").trim();
  if (name) return clampLabel(name);
  const identifier = (entity.identifier || "").trim();
  // For COMMENT/ATTACHMENT/ACTOR the backend backfills identifier FROM entity_id
  // when the node has no natural one, so this branch would otherwise return a
  // raw 32-char hash as the label. That is worse than the fallback below, and it
  // also wrecks the layout: getNodeCollisionRadius scales with label length, so
  // a 32-char label reserves roughly four times the space of a real name.
  if (identifier && identifier !== entity.entity_id) return clampLabel(identifier);
  // Matches the legend wording so a fallback label reads as the same kind of
  // thing the legend row names.
  // `type` is typed non-optional but arrives as unvalidated JSON, and this runs
  // inside the graphData memo — a throw here takes the whole graph down.
  const type = entity.type || "";
  const kind = AUX_FALLBACK_LABELS[type] || type.toLowerCase() || "node";
  const short = (entity.entity_id || "").slice(0, 8);
  return short ? `${kind} ${short}` : kind;
}

// ── Main component ──
export interface SourceGraphHandle {
  resetView: () => void;
  showNodeLabels: boolean;
  setShowNodeLabels: (v: boolean | ((prev: boolean) => boolean)) => void;
  showRelationLabels: boolean;
  setShowRelationLabels: (v: boolean | ((prev: boolean) => boolean)) => void;
  showNodeLogos: boolean;
  setShowNodeLogos: (v: boolean | ((prev: boolean) => boolean)) => void;
  /** Pre-truncation total node count (after semantic merging). */
  totalNodeCount: number;
  /** Nodes actually drawn after the budget is applied. Not always equal to the
   *  configured limit: a graph can run out of connected nodes to promote, and
   *  reporting the limit in that case overstates what the reader is seeing. */
  renderedNodeCount: number;
  /** Select + center + zoom a node by id (drives the external node finder). */
  focusNode: (id: string) => void;
  /** Currently-rendered nodes, for typeahead search. */
  nodes: { id: string; label: string }[];
  zoomIn: () => void;
  zoomOut: () => void;
  /** Zoom OUT to fit the entire graph in the viewport (no min-zoom clamp). */
  fitWholeGraph: () => void;
  /** Animate back to the default, comfortably-zoomed-in view. */
  defaultView: () => void;
}

export function SourceGraph({
  relations: inputRelations,
  auxiliaryRelations,
  isExpandedView = false,
  onClose,
  hideOverlayControls = false,
  controlRef,
  maxNodes,
  minHeight,
  fitWhole = false,
}: {
  relations: TripletWithEvidence[];
  /** Structural provenance layer. Opt-in: omitted on the query page
   *  and ingestion observe, where the graph is answer context and provenance
   *  edges would only add noise. Supplied on the graph page, which is the one
   *  place the user is exploring structure rather than reading an answer. */
  auxiliaryRelations?: TripletWithEvidence[];
  isExpandedView?: boolean;
  onClose?: () => void;
  /** When true, the built-in top-right controls (Labels, Reset View, Close) are hidden.
   *  Use `controlRef` to drive them externally. */
  hideOverlayControls?: boolean;
  /** Ref that exposes label toggles and resetView so the parent can render its own controls. */
  controlRef?: React.MutableRefObject<SourceGraphHandle | null>;
  /** When set, only the top N nodes (by connection count) are displayed. */
  maxNodes?: number;
  /** Overrides the default expanded graph minimum height for embedded layouts. */
  minHeight?: number;
  /** When true, the resting auto-fit zooms OUT to fit the ENTIRE graph (skips the
   *  FIT_MIN_ZOOM floor), so the whole graph is visible by default. */
  fitWhole?: boolean;
}) {
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ width: 0, height: 0 });
  const [selected, setSelected] = useState<
    { type: "node"; data: GNode } | { type: "link"; data: GLink } | null
  >(null);
  const [showNodeLabels, setShowNodeLabels] = useState(true);
  const [showRelationLabels, setShowRelationLabels] = useState(true);
  const [showNodeLogos, setShowNodeLogos] = useState(true);
  const [graphResetKey, setGraphResetKey] = useState(0);
  // Gates the canvas fade-in (see graphFadeInDelay). Starts hidden so the
  // initial layout math settles off-screen before the graph eases into view.
  const [graphReady, setGraphReady] = useState(false);

  // Load react-force-graph-2d with a plain client-side dynamic import rather
  // than next/dynamic. next/dynamic wraps the component in a loadable shell that
  // does NOT forward refs to the inner (forwardRef) component, so `fgRef.current`
  // stayed undefined — which silently turned every imperative call (d3Force
  // tuning, zoomToFit, clampFit, focusNode) into a no-op. Importing the module
  // directly and rendering it ourselves preserves native ref forwarding.
  const [ForceGraph2D, setForceGraph2D] = useState<
    typeof import("react-force-graph-2d").default | null
  >(null);
  useEffect(() => {
    let active = true;
    void import("react-force-graph-2d").then((mod) => {
      if (active) setForceGraph2D(() => mod.default);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries)
        setDims({ width: e.contentRect.width, height: e.contentRect.height });
    });
    setDims({
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const graphData = useMemo(() => {
    // The structural layer is merged into the SAME force graph rather than drawn
    // separately, so entity and provenance nodes share one layout — an entity
    // sitting next to the message it came from is the whole point. They stay
    // visually distinguishable via isAuxiliary (see auxNodeColor / dashed links).
    const relations: TripletWithEvidence[] = auxiliaryRelations?.length
      ? [
          ...inputRelations,
          ...auxiliaryRelations.filter(Boolean).map((t) => ({ ...t, _auxiliary: true })),
        ]
      : inputRelations;

    // Detect whether this relation set mixes knowledge + memory sources.
    // When mixed we use a semantic merge key so the same real-world entity
    // (which arrives with different entity_ids from each backend subtenant)
    // correctly collapses into a single "Both" node.
    const hasMixed = (() => {
      let hasK = false;
      let hasM = false;
      for (const t of relations) {
        if (!t) continue;
        if (t._graphSource === "knowledge") hasK = true;
        else if (t._graphSource === "memory") hasM = true;
        if (hasK && hasM) return true;
      }
      return false;
    })();

    const nodesMap = new Map<string, GNode>();
    const linksMap = new Map<string, GLink[]>();
    const allLinks: GLink[] = [];

    // Deduplicate relations. When the same semantic edge appears in both
    // knowledge and memory graphs we merge the `graphSource` and keep the
    // richer context rather than silently dropping the second occurrence.
    const edgeMap = new Map<
      string,
      {
        src: Entity;
        tgt: Entity;
        rel: RelationEvidence;
        gs: GraphSourceKind;
        srcKey: string;
        tgtKey: string;
        aux: boolean;
      }
    >();

    for (const t of relations) {
      if (!t) continue;
      for (const r of t.relations) {
        const srcKey = entityMergeKey(t.source, hasMixed);
        const tgtKey = entityMergeKey(t.target, hasMixed);
        const dedupKey = `${srcKey}___${tgtKey}___${r.canonical_predicate}`;
        const existing = edgeMap.get(dedupKey);
        if (!existing) {
          edgeMap.set(dedupKey, {
            src: t.source,
            tgt: t.target,
            rel: r,
            gs: t._graphSource || "knowledge",
            srcKey,
            tgtKey,
            aux: Boolean(t._auxiliary),
          });
        } else {
          // Merge graph source (knowledge + memory → both)
          existing.gs = mergeGraphSource(existing.gs, t._graphSource);
          // Keep whichever context is longer / more informative
          if (
            r.context &&
            (!existing.rel.context ||
              r.context.length > existing.rel.context.length)
          ) {
            existing.rel = { ...existing.rel, context: r.context };
          }
        }
      }
    }

    for (const { src, tgt, rel, gs, srcKey, tgtKey, aux } of edgeMap.values()) {
      if (!nodesMap.has(srcKey)) {
        nodesMap.set(srcKey, {
          id: srcKey,
          label: entityDisplayLabel(src),
          val: BASE_NODE_RADIUS,
          connectionCount: 1,
          kgConnectionCount: aux ? 0 : 1,
          color: nodeDotColor(gs),
          type: src.type,
          entity_id: src.entity_id,
          namespace: src.namespace,
          identifier: src.identifier,
          provider: src.provider || undefined,
          graphSource: gs,
          logoSrc: providerLogoImgSrc(src.provider),
          isAuxiliary: aux && AUX_NODE_TYPES.has(src.type),
          hydration: src.hydration,
        });
        if (aux && AUX_NODE_TYPES.has(src.type)) {
          nodesMap.get(srcKey)!.color = auxNodeColor(src.type, src.hydration);
        }
      } else {
        const existing = nodesMap.get(srcKey)!;
        existing.connectionCount += 1;
        if (!aux) existing.kgConnectionCount += 1;
        existing.val = Math.min(
          BASE_NODE_RADIUS + existing.connectionCount * 0.6,
          MAX_NODE_RADIUS,
        );
        existing.graphSource = mergeGraphSource(existing.graphSource, gs);
        if (!existing.isAuxiliary) {
          existing.color = nodeDotColor(existing.graphSource);
        }
        // Keep the first non-empty provider and backfill its logo if this node was first seen via a provider-less edge.
        if (!existing.provider && src.provider) {
          existing.provider = src.provider;
          existing.logoSrc = providerLogoImgSrc(src.provider);
        }
      }
      if (!nodesMap.has(tgtKey)) {
        nodesMap.set(tgtKey, {
          id: tgtKey,
          label: entityDisplayLabel(tgt),
          val: BASE_NODE_RADIUS,
          connectionCount: 1,
          kgConnectionCount: aux ? 0 : 1,
          color: nodeDotColor(gs),
          type: tgt.type,
          entity_id: tgt.entity_id,
          namespace: tgt.namespace,
          identifier: tgt.identifier,
          provider: tgt.provider || undefined,
          graphSource: gs,
          logoSrc: providerLogoImgSrc(tgt.provider),
          isAuxiliary: aux && AUX_NODE_TYPES.has(tgt.type),
          hydration: tgt.hydration,
        });
        if (aux && AUX_NODE_TYPES.has(tgt.type)) {
          nodesMap.get(tgtKey)!.color = auxNodeColor(tgt.type, tgt.hydration);
        }
      } else {
        const existing = nodesMap.get(tgtKey)!;
        existing.connectionCount += 1;
        if (!aux) existing.kgConnectionCount += 1;
        existing.val = Math.min(
          BASE_NODE_RADIUS + existing.connectionCount * 0.6,
          MAX_NODE_RADIUS,
        );
        existing.graphSource = mergeGraphSource(existing.graphSource, gs);
        if (!existing.isAuxiliary) {
          existing.color = nodeDotColor(existing.graphSource);
        }
        // Keep the first non-empty provider and backfill its logo if this node was first seen via a provider-less edge.
        if (!existing.provider && tgt.provider) {
          existing.provider = tgt.provider;
          existing.logoSrc = providerLogoImgSrc(tgt.provider);
        }
      }

      const linkKey = [srcKey, tgtKey].sort().join("___");
      if (!linksMap.has(linkKey)) linksMap.set(linkKey, []);
      const parallel = linksMap.get(linkKey)!;
      let curvature = 0;
      if (parallel.length > 0) {
        const sign = parallel.length % 2 === 0 ? 1 : -1;
        curvature = sign * (0.2 * Math.ceil(parallel.length / 2));
      }
      const link: GLink = {
        source: srcKey,
        target: tgtKey,
        // Structural predicates ship as snake_case identifiers; show the reader
        // a phrase instead ("mentioned in", not "present_in").
        label: linkLabel(rel, aux),
        color: aux ? COLOR_AUX_LINK : COLOR_LINK,
        curvature,
        context: rel.context,
        temporal_details: rel.temporal_details,
        graphSource: gs,
        isAuxiliary: aux,
        timestamp: rel.timestamp,
        synthesized: rel.synthesized,
      };
      parallel.push(link);
      allLinks.push(link);
    }
    let finalNodes = Array.from(nodesMap.values());
    let finalLinks = allLinks;

    // Client-side node truncation: keep only the top N nodes by connection count.
    if (maxNodes != null && finalNodes.length > maxNodes) {
      // Sort by raw connection count descending for deterministic ordering
      // (val is capped at MAX_NODE_RADIUS, making sort non-deterministic for highly connected nodes).
      const byDegree = (a: GNode, b: GNode) => b.connectionCount - a.connectionCount;
      // Entities rank on extracted degree only — see kgConnectionCount.
      const byKgDegree = (a: GNode, b: GNode) =>
        b.kgConnectionCount - a.kgConnectionCount ||
        b.connectionCount - a.connectionCount;

      // Budget the canvas in TWO passes when the provenance layer is on.
      //
      // A single top-N-by-degree pass would hand the whole budget to structural
      // nodes: one Source accumulates a present_in edge per entity it mentions
      // plus its comments, attachments and actors, so Sources outrank almost
      // every extracted entity. The entities — the actual subject of the page —
      // would be pushed off the canvas by their own provenance.
      //
      // So entities are ranked and kept first, then structural nodes are added
      // only where they attach to a kept entity, so what you see is the
      // provenance OF what is on screen rather than a disconnected scaffold.
      const entityNodes = finalNodes.filter((n) => !n.isAuxiliary);
      const auxNodes = finalNodes.filter((n) => n.isAuxiliary);

      let kept: Set<string>;
      if (auxNodes.length === 0 || entityNodes.length === 0) {
        // No provenance, or nothing but provenance. The two-pass split exists to
        // stop structural nodes crowding out entities; with only one kind on the
        // canvas there is nothing to balance, and running the split anyway would
        // seed the outward walk from an empty entity set, so its attachment gate
        // could never pass and the canvas would come back blank.
        kept = new Set([...finalNodes].sort(byDegree).slice(0, maxNodes).map((n) => n.id));
      } else {
        // Entities get the larger share; the remainder goes to provenance.
        const entityBudget = Math.max(1, Math.round(maxNodes * AUX_ENTITY_BUDGET_SHARE));
        const keptEntities = [...entityNodes].sort(byKgDegree).slice(0, entityBudget);
        const keptEntityIds = new Set(keptEntities.map((n) => n.id));

        // Walk OUTWARD from the kept entities rather than taking a single hop.
        // The provenance chain is Entity -> Source -> {Comment, Attachment,
        // Actor}, so comments, attachments and people sit TWO hops from an
        // entity. A one-hop rule keeps Sources and silently drops every other
        // structural kind — the legend rows for them would render empty on any
        // graph large enough to hit the node cap.
        //
        // Kinds are then taken round-robin rather than strictly by hop, so one
        // very talkative Source cannot spend the whole structural budget on its
        // own comments before any Actor or Attachment is drawn.
        const adjacency = new Map<string, string[]>();
        for (const l of allLinks) {
          const src = typeof l.source === "string" ? l.source : (l.source as GNode).id;
          const tgt = typeof l.target === "string" ? l.target : (l.target as GNode).id;
          if (!adjacency.has(src)) adjacency.set(src, []);
          if (!adjacency.has(tgt)) adjacency.set(tgt, []);
          adjacency.get(src)!.push(tgt);
          adjacency.get(tgt)!.push(src);
        }
        const auxBudget = Math.max(0, maxNodes - keptEntities.length);

        // Pool EVERY structural node, grouped by kind and ranked by degree.
        //
        // This deliberately does not pre-compute reachability. An earlier
        // version seeded a BFS from the initially-kept entities, which meant
        // provenance attached only to a LATER backfilled entity was never in
        // the pool at all and could never be selected — the graph stopped below
        // maxNodes with connected nodes still available.
        //
        // The selection gate below ("does this node already have a kept
        // neighbour?") enforces reachability dynamically instead, and gets hop
        // ordering for free: a Comment only becomes eligible once its Source
        // has been taken, whichever pass took it.
        const reachableByKind = new Map<string, GNode[]>();
        for (const n of [...auxNodes].sort(byDegree)) {
          const k = n.type || "";
          if (!reachableByKind.has(k)) reachableByKind.set(k, []);
          reachableByKind.get(k)!.push(n);
        }

        // Spend the budget round-robin across the kinds that are present, so
        // every structural kind on the graph gets representation. A single
        // best-first pass would return Sources only — there are far more of
        // them than slots — leaving the comment / attachment / person legend
        // rows permanently empty on any graph that hits the node cap.
        const keptAux: GNode[] = [];
        const taken = new Set<string>(keptEntityIds);
        const remaining = new Map<string, GNode[]>(
          [...reachableByKind].map(([k, list]) => [k, [...list]]),
        );
        const kinds = [...remaining.keys()];
        let progressed = true;
        while (keptAux.length < auxBudget && progressed) {
          progressed = false;
          for (const k of kinds) {
            if (keptAux.length >= auxBudget) break;
            const list = remaining.get(k)!;
            if (list.length === 0) continue;
            // Only take a node that already has a kept neighbour. Falling back
            // to an unattached one put a Comment or Actor on the canvas whose
            // Source had not been kept; the final link filter then dropped its
            // only edge and left it floating. Skipping the kind this round is
            // correct -- a later round may retain its Source and make it
            // attachable, and the loop keeps going while any kind progresses.
            const pick = list.findIndex((n) =>
              (adjacency.get(n.id) || []).some((id) => taken.has(id)),
            );
            if (pick === -1) continue;
            const [node] = list.splice(pick, 1);
            keptAux.push(node);
            taken.add(node.id);
            progressed = true;
          }
        }

        // Backfill whatever budget the round-robin could not use, from BOTH
        // pools and repeatedly: taking an entity can make a previously
        // unattached structural node attachable, which in turn can free more
        // entities' provenance. A single entity-only pass left capacity unused
        // whenever the leftover structural nodes sat outside the retained
        // entities' neighbourhood.
        const backfill: GNode[] = [];
        const spareEntities = [...entityNodes]
          .sort(byKgDegree)
          .filter((n) => !keptEntityIds.has(n.id));
        let filling = true;
        while (keptEntities.length + keptAux.length + backfill.length < maxNodes && filling) {
          filling = false;
          // Same attachment gate the structural pass uses. Without it the
          // backfill reaches into the degree-1 tail and adds entities whose only
          // neighbours were never kept; the link filter below then drops every
          // one of their edges and leaves bare dots floating in the gravity
          // well, which also inflate the legend's knowledge count.
          const ep = spareEntities.findIndex((n) =>
            (adjacency.get(n.id) || []).some((id) => taken.has(id)),
          );
          if (ep !== -1) {
            const [n] = spareEntities.splice(ep, 1);
            backfill.push(n);
            taken.add(n.id);
            filling = true;
          }
          if (keptEntities.length + keptAux.length + backfill.length >= maxNodes) break;
          // A newly kept entity may have made some structural node attachable.
          for (const k of kinds) {
            const list = remaining.get(k)!;
            const pick = list.findIndex((n) =>
              (adjacency.get(n.id) || []).some((id) => taken.has(id)),
            );
            if (pick === -1) continue;
            const [n] = list.splice(pick, 1);
            keptAux.push(n);
            taken.add(n.id);
            filling = true;
            break;
          }
        }

        kept = new Set([...keptEntities, ...keptAux, ...backfill].map((n) => n.id));
      }
      finalNodes = finalNodes.filter((n) => kept.has(n.id));
      finalLinks = allLinks.filter((l) => {
        const src =
          typeof l.source === "string" ? l.source : (l.source as GNode).id;
        const tgt =
          typeof l.target === "string" ? l.target : (l.target as GNode).id;
        return kept.has(src) && kept.has(tgt);
      });
    }

    return {
      nodes: finalNodes,
      links: finalLinks,
      totalNodeCount: nodesMap.size,
    };
  }, [inputRelations, auxiliaryRelations, maxNodes]);

  // Hold the graph hidden for a beat once it's mountable (module loaded + the
  // container measured), then fade it in. This lets the synchronous graphData
  // build, the force-simulation seeding, and the first auto-fit passes resolve
  // before anything is painted, so the graph eases in instead of snapping into
  // place. The delay scales with node count (graphFadeInDelay) so larger graphs,
  // which take longer to settle, wait longer. Keyed on hasDims (not the raw
  // width/height) so window resizes don't re-trigger a fade, and on
  // graphResetKey/graphData so a reset or new data set fades in fresh too.
  const hasDims = dims.width > 0 && dims.height > 0;
  useEffect(() => {
    if (!ForceGraph2D || !hasDims) return;
    setGraphReady(false);
    const timer = window.setTimeout(
      () => setGraphReady(true),
      graphFadeInDelay(graphData.nodes.length),
    );
    return () => window.clearTimeout(timer);
  }, [ForceGraph2D, hasDims, graphResetKey, graphData]);

  // Preload connector logos and force one repaint per newly-decoded image. The
  // force simulation may have already cooled by the time an SVG finishes
  // decoding; bumping this reducer re-renders SourceGraph, which hands the
  // canvas a fresh nodeCanvasObject closure and triggers a repaint so the logo
  // actually appears.
  const [, bumpLogoTick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    let cancelled = false;
    const bump = () => {
      if (!cancelled) bumpLogoTick();
    };
    for (const node of graphData.nodes) {
      if (!node.logoSrc) continue;
      const img = getLogoImage(node.logoSrc);
      if (!img.complete || img.naturalWidth === 0) {
        img.addEventListener("load", bump, { once: true });
      }
    }
    return () => {
      cancelled = true;
    };
  }, [graphData.nodes]);

  /** Node counts per visual kind, for the legend. */
  const typeCounts = useMemo(() => {
    const c = { entity: 0, memory: 0, knowledge: 0 };
    for (const n of graphData.nodes) {
      // Structural nodes are counted separately below; folding them into the
      // entity tally would overstate how much extracted knowledge is on screen.
      if (n.isAuxiliary) continue;
      c[nodeKindFor(n.graphSource)] += 1;
    }
    return c;
  }, [graphData.nodes]);

  /** Sources on screen that are referenced but not ingested. Drawn hollow, and
   *  called out separately so a forward reference is never counted as a real
   *  document the reader could open. */
  const unresolvedSourceCount = useMemo(
    () =>
      graphData.nodes.filter(
        (n) => n.isAuxiliary && isUnresolvedSource(n.hydration),
      ).length,
    [graphData.nodes],
  );

  /** Structural node counts per kind, for the provenance legend rows. Empty
   *  when the layer is off, which is what hides those rows entirely. */
  const auxCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const n of graphData.nodes) {
      if (!n.isAuxiliary || !n.type) continue;
      c[n.type] = (c[n.type] || 0) + 1;
    }
    return c;
  }, [graphData.nodes]);

  // Is the provenance layer actually on screen? Keyed on LINKS, not nodes: the
  // edge legend explains the dash, so it should appear exactly when a dashed
  // edge is drawable. A structural node kept without any of its edges surviving
  // the budget would otherwise advertise a line style nothing on screen uses.
  const hasAux = useMemo(
    () => graphData.links.some((l) => (l as GLink).isAuxiliary),
    [graphData.links],
  );

  // One authoritative, INSTANT fit. zoomToFit fits the whole graph to the
  // viewport, then we clamp the resulting zoom into [FIT_MIN_ZOOM, FIT_MAX_ZOOM].
  // Everything is instant (duration 0): the previous animated version let
  // zoomToFit's in-flight animation override the clamp (a timing race), which
  // left the camera stuck at a tiny whole-graph scale — the bug behind "I have
  // to zoom in 3× to see anything". Instant ops have no race: the clamp is the
  // last thing to run, so it always wins.
  // When fitWhole is on (the Graph page default), the resting view fits the
  // ENTIRE graph — over-zoom is still capped at FIT_MAX_ZOOM, but the
  // FIT_MIN_ZOOM floor is skipped so large graphs zoom all the way out instead
  // of staying cropped. Read through a ref so toggling fit-view doesn't change
  // clampFit's identity (which would reheat the layout via the forces effect).
  const fitWholeRef = useRef(fitWhole);
  useEffect(() => {
    fitWholeRef.current = fitWhole;
  }, [fitWhole]);

  const clampFit = useCallback(() => {
    const c = fgRef.current;
    if (!c) return;
    const padding = isExpandedView ? 80 : 60;
    c.zoomToFit(0, padding);
    const k = c.zoom();
    if (typeof k === "number") {
      if (k > FIT_MAX_ZOOM) c.zoom(FIT_MAX_ZOOM, 0);
      else if (!fitWholeRef.current && k < FIT_MIN_ZOOM) c.zoom(FIT_MIN_ZOOM, 0);
    }
  }, [isExpandedView]);

  const fitGraphView = useCallback(() => {
    // The layout is still settling when this first fires, so re-fit a few times
    // to track the spreading positions. The definitive fit happens in
    // onEngineStop (below), once the simulation has fully cooled.
    clampFit();
    window.setTimeout(clampFit, 300);
    window.setTimeout(clampFit, 900);
    window.setTimeout(clampFit, 1800);
  }, [clampFit]);

  const resetGraphView = useCallback(() => {
    setSelected(null);
    setGraphResetKey((key) => key + 1);
  }, []);

  // "Fit view" ON — zoom OUT (animated) so the whole graph is visible. Unlike
  // the default view, this is allowed to go below FIT_MIN_ZOOM; only over-zoom on
  // tiny graphs is capped.
  const fitWholeGraph = useCallback(() => {
    const c = fgRef.current;
    if (!c) return;
    const padding = isExpandedView ? 80 : 60;
    c.zoomToFit(600, padding);
    window.setTimeout(() => {
      const cc = fgRef.current;
      if (!cc) return;
      const k = cc.zoom();
      if (typeof k === "number" && k > FIT_MAX_ZOOM) cc.zoom(FIT_MAX_ZOOM, 300);
    }, 620);
  }, [isExpandedView]);

  // "Fit view" OFF — animate back to the default comfortably-zoomed-in view
  // (same target as the initial load: fit, then clamp into [MIN, MAX]).
  const defaultView = useCallback(() => {
    const c = fgRef.current;
    if (!c) return;
    const padding = isExpandedView ? 80 : 60;
    c.zoomToFit(0, padding);
    const k = c.zoom();
    const target =
      typeof k === "number"
        ? Math.min(Math.max(k, FIT_MIN_ZOOM), FIT_MAX_ZOOM)
        : FIT_MIN_ZOOM;
    c.zoom(target, 600);
  }, [isExpandedView]);

  // Select + center + zoom a node by id — drives the external "Find a node" search.
  const focusNode = useCallback(
    (id: string) => {
      const node = graphData.nodes.find((n) => n.id === id);
      if (!node) return;
      setSelected({ type: "node", data: node });
      const fg = fgRef.current;
      if (fg && node.x != null && node.y != null) {
        fg.centerAt(node.x, node.y, 600);
        // Zoom in only enough to bring the node and its immediate neighbourhood
        // into focus — but never zoom OUT if the user is already closer than
        // this. Hard-zooming to 4 (the old value) overshot the new default
        // scale and felt jarring.
        const current = fg.zoom();
        fg.zoom(Math.max(typeof current === "number" ? current : 0, 2), 600);
      }
    },
    [graphData.nodes],
  );

  // Expose controls to parent via ref
  useEffect(() => {
    if (controlRef) {
      controlRef.current = {
        resetView: resetGraphView,
        showNodeLabels,
        setShowNodeLabels,
        showRelationLabels,
        setShowRelationLabels,
        showNodeLogos,
        setShowNodeLogos,
        totalNodeCount: graphData.totalNodeCount,
        renderedNodeCount: graphData.nodes.length,
        focusNode,
        nodes: graphData.nodes.map((n) => ({ id: n.id, label: n.label })),
        zoomIn: () => {
          const fg = fgRef.current;
          if (fg) {
            const currentZoom = fg.zoom();
            fg.zoom(currentZoom * 1.3, 300);
          }
        },
        zoomOut: () => {
          const fg = fgRef.current;
          if (fg) {
            const currentZoom = fg.zoom();
            fg.zoom(currentZoom / 1.3, 300);
          }
        },
        fitWholeGraph,
        defaultView,
      };
    }
    // Drop the handle on unmount. The parent polls this ref for totalNodeCount,
    // and the graph unmounts while a new scope loads — without this the ref
    // keeps answering with the previous graph's counts, so a poll tick can
    // restore a stale total after the parent has already cleared it.
    return () => {
      if (controlRef) controlRef.current = null;
    };
  }, [
    controlRef,
    resetGraphView,
    focusNode,
    fitWholeGraph,
    defaultView,
    showNodeLabels,
    showRelationLabels,
    showNodeLogos,
    graphData,
  ]);

  useEffect(() => {
    let attempts = 0;
    let timer: number;
    const applyForces = () => {
      const fg = fgRef.current;
      // The graph instance mounts asynchronously (dynamic import + canvas init),
      // so the ref may not be live on the first tick. Retry until it is, instead
      // of bailing out once and leaving the default forces in place forever.
      if (!fg) {
        if (attempts++ < 40) timer = window.setTimeout(applyForces, 100);
        return;
      }
      const nodeById = new Map(graphData.nodes.map((node) => [node.id, node]));
      // Charge gives nodes breathing room WITHIN a cluster, but with no range
      // limit it also makes far-apart disconnected components repel each other
      // across the whole canvas — the islands scatter to the corners. Capping
      // distanceMax makes repulsion local, so gravity (below) can win over the
      // empty gaps and pull every island into one compact, readable cluster.
      const charge = fg.d3Force("charge");
      if (charge) {
        // Repulsion is deliberately weak: collision (below) already guarantees
        // nodes never overlap, so strong charge only serves to stretch every
        // edge far past its link rest-length (the "edges too big" problem). Keep
        // just enough to give a little breathing room within a cluster.
        charge.strength(isExpandedView ? -30 : -24);
        // Keep repulsion strictly local. Beyond this range nodes feel no push,
        // so two disconnected islands can't shove each other to opposite
        // corners — gravity (below) then wins the empty gap and packs them
        // adjacent. Smaller range = tighter island packing.
        (charge as unknown as { distanceMax: (d: number) => void }).distanceMax(
          isExpandedView ? 150 : 110,
        );
      }
      fg.d3Force("link")?.distance((link: LinkObject) =>
        getGraphLinkDistance(
          link,
          nodeById,
          isExpandedView,
          showNodeLabels,
          showRelationLabels,
        ),
      );
      fg.d3Force(
        "collide",
        forceCollide<NodeObject>()
          .radius((node) =>
            showNodeLabels
              ? getNodeCollisionRadius(node)
              : Math.max(
                  getVisibleNodeRadius(node as GNode, false) + 8,
                  MIN_NODE_HIT_RADIUS,
                ),
          )
          .strength(1)
          .iterations(6),
      );
      // Gravity toward the origin on both axes gathers disconnected islands into
      // a single cluster (collision still guarantees minimum spacing, so this
      // tightens empty gaps without overlapping nodes). Equal X/Y strength keeps
      // the result a compact disc rather than a vertical or horizontal smear.
      // Strong enough to overpower the (now short-range) charge across the empty
      // gaps between islands, so the whole graph collapses into one dense,
      // readable mass instead of scattering to the corners.
      const gravity = isExpandedView ? 0.26 : 0.34;
      let xF = fg.d3Force("x");
      if (!xF) {
        xF = forceX(0);
        fg.d3Force("x", xF);
      }
      xF.strength(gravity);
      let yF = fg.d3Force("y");
      if (!yF) {
        yF = forceY(0);
        fg.d3Force("y", yF);
      }
      yF.strength(gravity);
      fg.d3ReheatSimulation();
      fitGraphView();
    };
    timer = window.setTimeout(applyForces, 50);
    return () => window.clearTimeout(timer);
  }, [
    ForceGraph2D,
    fitGraphView,
    graphData,
    isExpandedView,
    showNodeLabels,
    showRelationLabels,
  ]);

  const selectedNodeId = selected?.type === "node" ? selected.data.id : null;
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hoveredLink, setHoveredLink] = useState<LinkObject | null>(null);
  // Drop a selection whose node no longer exists after a rebuild.
  //
  // Everything downstream keys off `activeId`: when it is set but matches no
  // node, `isActive` is false everywhere, `neighborIds` is empty, and the dim
  // predicate is therefore true for EVERY node and link — the whole canvas goes
  // to 22% alpha with a detail panel describing something that is not drawn,
  // and the only way back is a background click nobody would guess.
  //
  // Reachable whenever the node set changes under a live selection: moving the
  // max-nodes slider, changing the relation filter, switching tenant, or
  // picking a different document on ingestion observe. The provenance layer
  // made it considerably more likely, because lowering the budget re-runs the
  // whole entity/structural selection rather than just trimming the tail.
  useEffect(() => {
    setHoveredId(null);
    setHoveredLink(null);
    setSelected((cur) => {
      if (!cur) return cur;
      if (cur.type === "link") return null;
      const id = (cur.data as GNode).id;
      return graphData.nodes.some((n) => n.id === id) ? cur : null;
    });
  }, [graphData]);

  // Hover takes precedence over click-selection so moving the cursor always
  // lights up that node's neighbourhood (the reference's focus||hover model).
  const activeId = hoveredId ?? selectedNodeId;

  // Ids of nodes directly connected to the active node — drives the orange
  // highlight + dimming of everything else.
  const neighborIds = useMemo(() => {
    const s = new Set<string>();
    if (!activeId) return s;
    for (const l of graphData.links) {
      const a = getLinkEndpointId(l.source as string | NodeObject);
      const b = getLinkEndpointId(l.target as string | NodeObject);
      if (a === activeId && b) s.add(b);
      else if (b === activeId && a) s.add(a);
    }
    return s;
  }, [activeId, graphData.links]);

  const isLinkIncident = (l: LinkObject) => {
    // Hover wins over click-selection, mirroring activeId above: pointing at an
    // edge lights it up even while another relation is pinned in the panel.
    if (hoveredLink) return hoveredLink === l;
    if (selected?.type === "link") return selected.data === l;
    if (!activeId) return false;
    const lk = l as GLink;
    return (
      getLinkEndpointId(lk.source as string | NodeObject) === activeId ||
      getLinkEndpointId(lk.target as string | NodeObject) === activeId
    );
  };

  // A graph with provenance but no extracted relations is still a graph. The
  // backend cannot produce that today — hydrateAuxiliary returns early when
  // Relations is empty, and the aux scope is derived from those relations — but
  // the guard should not be the thing that depends on it.
  if (inputRelations.length === 0 && !auxiliaryRelations?.length) {
    return (
      <div
        style={{
          display: "grid",
          placeItems: "center",
          height: "100%",
          color: "var(--fg-3)",
          fontSize: 13,
        }}
      >
        No graph relations found for this source.
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: isExpandedView ? "100%" : 500,
        minHeight: minHeight ?? (isExpandedView ? 500 : undefined),
        borderRadius: "var(--radius)",
        border: "1px solid var(--line)",
        overflow: "hidden",
        position: "relative",
        background: "#141414",
        backgroundImage:
          "radial-gradient(rgba(255,255,255,0.05) 0.7px, transparent 0.7px)",
        backgroundSize: "22px 22px",
      }}
    >
      {dims.width > 0 && dims.height > 0 && (
        <>
          {/* Info panel */}
          {selected && (
            <div
              style={{
                position: "absolute",
                top: 16,
                left: 16,
                zIndex: 10,
                maxWidth: 360,
                pointerEvents: "none",
              }}
            >
              <div
                style={{
                  ...GRAPH_PANEL_STYLE,
                  padding: 16,
                  borderRadius: 8,
                  pointerEvents: "auto",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 10,
                  }}
                >
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: "var(--fg)",
                    }}
                  >
                    {selected.type === "link"
                      ? "Relation Context"
                      : (selected.data as GNode).isAuxiliary
                        ? // A Source, a comment or a person is not an extracted
                          // entity, and calling it one undoes the distinction the
                          // whole provenance layer exists to draw.
                          `${AUX_DETAIL_TITLES[(selected.data as GNode).type || ""] || "Source"} Details`
                        : "Entity Details"}
                  </span>
                  <button
                    className="icon-btn"
                    onClick={() => setSelected(null)}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </div>

                {selected.type === "link" ? (
                  <div>
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        alignItems: "center",
                        gap: 6,
                        fontSize: 11,
                        marginBottom: 10,
                      }}
                    >
                      <span
                        style={{
                          padding: "3px 8px",
                          borderRadius: 4,
                          background: "var(--accent-tint)",
                          color: "var(--accent)",
                          border: "1px solid var(--accent-line)",
                          fontFamily: "var(--mono)",
                        }}
                      >
                        {(selected.data.source as unknown as GNode).label}
                      </span>
                      <span style={{ color: "var(--fg-4)" }}>&rarr;</span>
                      <span
                        style={{
                          padding: "3px 8px",
                          borderRadius: 4,
                          background: "var(--bg-3)",
                          color: "var(--highlight)",
                          border: "1px solid var(--line-2)",
                          fontFamily: "var(--mono)",
                        }}
                      >
                        {selected.data.label.toUpperCase()}
                      </span>
                      <span style={{ color: "var(--fg-4)" }}>&rarr;</span>
                      <span
                        style={{
                          padding: "3px 8px",
                          borderRadius: 4,
                          background: "var(--bg-3)",
                          color: "var(--fg)",
                          border: "1px solid var(--line-2)",
                          fontFamily: "var(--mono)",
                        }}
                      >
                        {(selected.data.target as unknown as GNode).label}
                      </span>
                    </div>
                    {selected.data.graphSource && (
                      <div style={{ marginBottom: 6 }}>
                        <span
                          style={{
                            display: "inline-block",
                            fontSize: 10,
                            fontWeight: 600,
                            letterSpacing: "0.04em",
                            padding: "2px 8px",
                            borderRadius: 4,
                            textTransform: "uppercase",
                            background:
                              selected.data.graphSource === "memory"
                                ? "rgba(255,196,35,0.15)"
                                : "var(--bg-3)",
                            color:
                              selected.data.graphSource === "memory"
                                ? "var(--highlight)"
                                : "var(--fg-3)",
                            border: `1px solid ${selected.data.graphSource === "memory" ? "rgba(255,196,35,0.3)" : "var(--line-2)"}`,
                          }}
                        >
                          {GRAPH_SOURCE_LABELS[selected.data.graphSource]}
                        </span>
                      </div>
                    )}
                    {selected.data.context ? (
                      <p
                        style={{
                          fontSize: 12,
                          color: "var(--fg-3)",
                          lineHeight: 1.6,
                          margin: 0,
                        }}
                      >
                        {selected.data.context}
                      </p>
                    ) : selected.data.isAuxiliary ? (
                      // Structural edges carry no extracted sentence — the
                      // backend sets context to "" for all of them. Both bodies
                      // below were gated on fields that are always empty here,
                      // so clicking any provenance edge opened a panel with a
                      // heading and nothing under it, which reads as a failed
                      // load rather than as "there is no sentence behind this".
                      <p
                        style={{
                          fontSize: 12,
                          color: "var(--fg-3)",
                          lineHeight: 1.6,
                          margin: 0,
                        }}
                      >
                        Recorded from the source itself, not extracted from
                        text - so there is no sentence behind it.
                        {selected.data.timestamp && !selected.data.synthesized && (
                          <>
                            {" "}
                            Recorded{" "}
                            <span style={{ fontFamily: "var(--mono)" }}>
                              {selected.data.timestamp.slice(0, 10)}
                            </span>
                            .
                          </>
                        )}
                      </p>
                    ) : (
                      // An extracted relation with no recorded sentence. Rare --
                      // zero of 54,333 sampled -- but the old branch rendered
                      // NOTHING here, which looks like a failed load rather than
                      // like an absent field.
                      <p
                        style={{
                          fontSize: 12,
                          color: "var(--fg-3)",
                          lineHeight: 1.6,
                          margin: 0,
                        }}
                      >
                        No source sentence was recorded for this relation.
                      </p>
                    )}
                    {selected.data.temporal_details && (
                      <div
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          marginTop: 8,
                          padding: "3px 8px",
                          borderRadius: 4,
                          fontSize: 11,
                          background: "var(--bg-2)",
                          color: "var(--fg-3)",
                          border: "1px solid var(--line)",
                        }}
                      >
                        <span
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: "50%",
                            background: "#3b82f6",
                          }}
                        />
                        {selected.data.temporal_details}
                      </div>
                    )}
                  </div>
                ) : (
                  <div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        marginBottom: 10,
                      }}
                    >
                      {selected.data.provider ? (
                        // Connector logo for entities sourced from an app
                        // integration; falls back to the graph-source colour dot
                        // when no brand mark is registered for the provider.
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 20,
                            height: 20,
                            borderRadius: 5,
                            background: "#ffffff",
                            border: "1px solid rgba(0, 0, 0, 0.10)",
                            color: "#1a1a1a",
                            flexShrink: 0,
                          }}
                        >
                          <ProviderLogo
                            id={providerLogoId(selected.data.provider)}
                            size={13}
                            fallback={
                              <span
                                style={{
                                  width: 10,
                                  height: 10,
                                  borderRadius: "50%",
                                  background: selected.data.color || "#fff",
                                }}
                              />
                            }
                          />
                        </span>
                      ) : (
                        <span
                          style={{
                            width: 12,
                            height: 12,
                            borderRadius: "50%",
                            background: selected.data.color || "#fff",
                          }}
                        />
                      )}
                      <span
                        style={{
                          fontSize: 16,
                          fontWeight: 500,
                          color: "var(--fg)",
                        }}
                      >
                        {selected.data.label}
                      </span>
                    </div>
                    {selected.data.graphSource && (
                      <div style={{ marginBottom: 8 }}>
                        <span
                          style={{
                            display: "inline-block",
                            fontSize: 10,
                            fontWeight: 600,
                            letterSpacing: "0.04em",
                            padding: "2px 8px",
                            borderRadius: 4,
                            textTransform: "uppercase",
                            background:
                              selected.data.graphSource === "memory"
                                ? "rgba(255,196,35,0.15)"
                                : selected.data.graphSource === "both"
                                  ? "var(--accent-tint)"
                                  : "var(--bg-3)",
                            color:
                              selected.data.graphSource === "memory"
                                ? "var(--highlight)"
                                : selected.data.graphSource === "both"
                                  ? "var(--accent)"
                                  : "var(--fg-3)",
                            border: `1px solid ${
                              selected.data.graphSource === "memory"
                                ? "rgba(255,196,35,0.3)"
                                : selected.data.graphSource === "both"
                                  ? "var(--accent-line)"
                                  : "var(--line-2)"
                            }`,
                          }}
                        >
                          {GRAPH_SOURCE_LABELS[selected.data.graphSource]}
                        </span>
                      </div>
                    )}
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: 6,
                        fontSize: 12,
                      }}
                    >
                      {selected.data.provider && (
                        <>
                          <span style={{ color: "var(--fg-3)" }}>Source</span>
                          <span style={{ color: "var(--fg)" }}>
                            {providerLabel(selected.data.provider)}
                          </span>
                        </>
                      )}
                      {selected.data.type && (
                        <>
                          <span style={{ color: "var(--fg-3)" }}>Type</span>
                          <span style={{ color: "var(--fg)" }}>
                            {selected.data.type}
                          </span>
                        </>
                      )}
                      {selected.data.namespace &&
                        selected.data.namespace !== "default" && (
                          <>
                            <span style={{ color: "var(--fg-3)" }}>
                              Namespace
                            </span>
                            <span style={{ color: "var(--fg)" }}>
                              {selected.data.namespace}
                            </span>
                          </>
                        )}
                      {selected.data.entity_id && (
                        <>
                          <span style={{ color: "var(--fg-3)" }}>
                            Entity ID
                          </span>
                          <span
                            style={{
                              color: "var(--fg)",
                              fontFamily: "var(--mono)",
                              fontSize: 10,
                              wordBreak: "break-all",
                            }}
                          >
                            {selected.data.entity_id}
                          </span>
                        </>
                      )}
                      {/* The backend backfills identifier FROM entity_id for
                          Comment / Attachment / Actor, so without this guard
                          every structural node's panel prints the same 32-char
                          hash twice under two different labels. */}
                      {selected.data.identifier &&
                        selected.data.identifier !== selected.data.entity_id && (
                        <>
                          <span style={{ color: "var(--fg-3)" }}>
                            Identifier
                          </span>
                          <span style={{ color: "var(--fg)" }}>
                            {selected.data.identifier}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {ForceGraph2D && (
          <div
            style={{
              opacity: graphReady ? 1 : 0,
              transition: `opacity ${GRAPH_FADE_IN_DURATION_MS}ms ease-out`,
            }}
          >
          <ForceGraph2D
            key={graphResetKey}
            ref={fgRef}
            width={dims.width}
            height={dims.height}
            graphData={graphData}
            nodeLabel="label"
            nodeColor="color"
            backgroundColor="rgba(0,0,0,0)"
            nodeRelSize={3}
            linkHoverPrecision={6}
            linkColor={(link) => {
              if (isLinkIncident(link)) return COLOR_ACCENT;
              if ((link as GLink).isAuxiliary) {
                return activeId ? COLOR_LINK_DIM : COLOR_AUX_LINK;
              }
              return activeId ? COLOR_LINK_DIM : COLOR_LINK;
            }}
            // Structural edges are drawn thinner and dashed so provenance never
            // reads as an extracted fact at a glance.
            linkLineDash={(link) => ((link as GLink).isAuxiliary ? [4, 3] : null)}
            linkWidth={(link) =>
              isLinkIncident(link) ? 3 : (link as GLink).isAuxiliary ? 1.1 : 1.6
            }
            linkDirectionalArrowLength={0}
            linkDirectionalArrowRelPos={1}
            linkCurvature={(d) => (d as GLink).curvature || 0}
            onNodeHover={(node) =>
              setHoveredId(node ? (node as GNode).id : null)
            }
            onLinkHover={(link) => setHoveredLink(link)}
            onNodeClick={(node) =>
              setSelected({ type: "node", data: node as GNode })
            }
            onLinkClick={(link) =>
              setSelected({ type: "link", data: link as GLink })
            }
            onBackgroundClick={() => setSelected(null)}
            // force-graph pointers the cursor for anything with a click handler
            // — including the background, since onBackgroundClick is set. That
            // left the pointer showing everywhere, so it never signalled that a
            // node/edge in particular is clickable. Restrict it to real objects.
            showPointerCursor={(obj) => !!obj}
            linkLabel={() => ""}
            nodePointerAreaPaint={(n, color, ctx, globalScale) => {
              const node = n as GNode;
              // Paint the hit area in SCREEN space (constant pixel size) so the
              // clickable region never collapses when zoomed out on a big graph.
              // The library has already applied the camera transform
              // (translate(t.x,t.y) * scale(t.k)) to `ctx`; we read the current
              // transform to recover the screen position of the node, then reset
              // to identity so we can paint in literal pixels.
              const r =
                getNodeScaledRadius(node, globalScale) + NODE_PIXEL_HIT_PADDING;
              const m = ctx.getTransform();
              const sx = m.a * node.x! + m.c * node.y! + m.e;
              const sy = m.b * node.x! + m.d * node.y! + m.f;
              ctx.save();
              ctx.setTransform(1, 0, 0, 1, 0, 0); // identity — work in pixels
              ctx.fillStyle = color;
              ctx.beginPath();
              ctx.arc(sx, sy, Math.max(r, MIN_NODE_HIT_RADIUS), 0, 2 * Math.PI);
              ctx.fill();
              ctx.restore();
            }}
            nodeCanvasObject={(n: NodeObject, ctx, globalScale) => {
              const node = n as GNode;
              const kind = nodeKindFor(node.graphSource);
              const baseR = getNodeScaledRadius(node, globalScale);
              const isActive = activeId === node.id;
              const isSelected = selectedNodeId === node.id;
              const isHover = hoveredId === node.id;
              const isNeighbor = activeId != null && neighborIds.has(node.id);
              const dim = activeId != null && !isActive && !isNeighbor;
              // Searched/clicked node is enlarged so it's unmistakable.
              const r = isSelected
                ? baseR * NODE_PIXEL_SELECTED_BOOST + 1
                : baseR;

              // The structural ring is stroked CENTRED on r, so it occupies
              // r +/- half its width. Anything drawn inside the node must stop
              // short of `r - auxRingWidth / 2` or it eats the ring — which is
              // the only thing carrying that node's kind.
              const auxRingWidth = Math.max(1.5, Math.min(3, r * 0.34));

              // Screen-space coordinates (pixels). We reset the transform to
              // identity so radii, line widths, and font sizes are literal
              // pixels — independent of the camera zoom. This is what keeps the
              // graph legible at any scale: nodes are always the same pixel
              // size, just positioned differently as the camera moves.
              // The library applied translate(t.x,t.y)*scale(t.k) to ctx; we
              // recover the full screen position (including pan) from the
              // current transform matrix rather than just node.x*globalScale
              // (which would miss the pan offset).
              const m = ctx.getTransform();
              const sx = m.a * node.x! + m.c * node.y! + m.e;
              const sy = m.b * node.x! + m.d * node.y! + m.f;
              // The library scales the context by the device pixel ratio; once we
              // reset to the identity transform below, font sizes become literal
              // device pixels. Recover the DPR (m.a === dpr * globalScale) so the
              // label font renders at true CSS pixels — otherwise on a retina
              // screen labels render at half size and look smaller than the
              // relation labels (which keep the DPR-scaled context).
              const pixelRatio = globalScale > 0 ? m.a / globalScale : 1;

              ctx.save();
              ctx.setTransform(1, 0, 0, 1, 0, 0);
              ctx.globalAlpha = dim ? 0.22 : 1;

              // Focus affordance: corner brackets on click-select, ring on hover.
              if (isSelected) {
                const s = r + NODE_PIXEL_SELECTED_BRACKET_OFFSET;
                const t = Math.max(3, s * 0.32);
                ctx.strokeStyle = COLOR_ACCENT;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(sx - s, sy - s + t);
                ctx.lineTo(sx - s, sy - s);
                ctx.lineTo(sx - s + t, sy - s);
                ctx.moveTo(sx + s - t, sy - s);
                ctx.lineTo(sx + s, sy - s);
                ctx.lineTo(sx + s, sy - s + t);
                ctx.moveTo(sx + s, sy + s - t);
                ctx.lineTo(sx + s, sy + s);
                ctx.lineTo(sx + s - t, sy + s);
                ctx.moveTo(sx - s + t, sy + s);
                ctx.lineTo(sx - s, sy + s);
                ctx.lineTo(sx - s, sy + s - t);
                ctx.stroke();
              } else if (isHover) {
                ctx.beginPath();
                ctx.arc(
                  sx,
                  sy,
                  r + NODE_PIXEL_HOVER_RING_OFFSET,
                  0,
                  2 * Math.PI,
                );
                ctx.strokeStyle = COLOR_ACCENT;
                ctx.lineWidth = 1;
                ctx.globalAlpha = dim ? 0.22 : 0.5;
                ctx.stroke();
                ctx.globalAlpha = dim ? 0.22 : 1;
              }

              // Node body.
              ctx.beginPath();
              ctx.arc(sx, sy, r, 0, 2 * Math.PI);
              if (isActive) {
                ctx.fillStyle = COLOR_ACCENT;
                ctx.fill();
              } else {
                // Memory nodes are brand yellow; everything else (knowledge +
                // entity) renders as a unified solid grey — knowledge nodes used
                // to be drawn hollow (black fill + grey ring) which read as a
                // different "black" node type.
                //
                // Structural nodes are RINGED, not filled, and the ring is
                // DOTTED: a neutral body with the kind carried on the border.
                // That keeps two facts legible at once — the dotted pattern says
                // "auxiliary, not an extracted entity" without depending on
                // colour, and the colour says which kind — without minting four
                // more solid fills that compete with the entity/memory palette
                // for attention.
                if (node.isAuxiliary) {
                  ctx.fillStyle = COLOR_AUX_BODY;
                  ctx.fill();
                  ctx.strokeStyle = node.color || COLOR_AUX_LINK;
                  // Scale with the node so the ring stays visible on small dots
                  // without swallowing large ones.
                  ctx.lineWidth = auxRingWidth;
                  const priorCap = ctx.lineCap;
                  if (isUnresolvedSource(node.hydration)) {
                    // Referenced but never ingested: a broken ring, because
                    // there is nothing behind it to open. Long dashes, so it
                    // stays distinguishable from the dotted ring every other
                    // structural node now wears.
                    ctx.setLineDash([4, 3]);
                  } else {
                    // Dotted, and dotted for EVERY structural node -- the ring
                    // pattern now says "auxiliary" on its own, so the layer
                    // reads as a layer even where colour alone is ambiguous
                    // (an orange source beside the orange accent, a small node
                    // where the ring is only a few pixels of arc).
                    //
                    // Round caps plus a near-zero dash length is what produces
                    // ROUND dots; a plain short dash renders as tiny rectangles
                    // that read as a broken line rather than a dotted one. The
                    // gap scales with the stroke so the dots stay separated at
                    // every node size.
                    ctx.lineCap = "round";
                    ctx.setLineDash([0.1, auxRingWidth * 2.2]);
                  }
                  ctx.stroke();
                  ctx.setLineDash([]);
                  ctx.lineCap = priorCap;
                } else {
                  ctx.fillStyle = kind === "memory" ? COLOR_MEMORY : COLOR_ENTITY;
                  ctx.fill();
                }
              }

              // Connector logo inside the node. The mark sits on a white disc
              // (logo-only background) inset from the edge, so the node's colour
              // survives as a thin ring that still encodes its knowledge/memory/
              // active kind while the brand logo stays legible on top.
              // On a SOURCE the connector mark IS the node's identity -- that
              // node is the Slack message, the Linear issue, the Drive file --
              // so it earns the logo. The other structural kinds do not: a
              // Comment, an Attachment and an Actor all inherit their provider
              // from the parent Source, so painting it there attributed a person
              // to a connector, and three different kinds reduced to the same
              // white circle with the same mark.
              const wantsLogo =
                !node.isAuxiliary || node.type === "SOURCE";
              if (node.logoSrc && showNodeLogos && wantsLogo) {
                const img = getLogoImage(node.logoSrc);
                if (img.complete && img.naturalWidth > 0) {
                  // Inside the ring, not over it. An entity has no ring, so it
                  // keeps the original inset.
                  const innerR = node.isAuxiliary
                    ? Math.max(2, r - auxRingWidth / 2 - 0.75)
                    : Math.max(2, r - Math.max(1, r * 0.16));
                  ctx.save();
                  ctx.beginPath();
                  ctx.arc(sx, sy, innerR, 0, 2 * Math.PI);
                  ctx.fillStyle = "#ffffff";
                  ctx.fill();
                  ctx.clip();
                  // Contain the (square) logo within the disc with light padding.
                  const d = innerR * 2 * 0.82;
                  ctx.drawImage(img, sx - d / 2, sy - d / 2, d, d);
                  ctx.restore();
                }
              }

              // Label below the node (plain text, no box — matches the reference).
              // LOD: hide ordinary labels when zoomed out to avoid soup; active/
              // hovered/selected nodes always keep their label.
              const labelEligible =
                showNodeLabels &&
                !dim &&
                (isActive ||
                  isHover ||
                  isSelected ||
                  globalScale >= NODE_LABEL_MIN_ZOOM);
              if (labelEligible) {
                ctx.font = `${NODE_LABEL_FONT_SIZE * pixelRatio}px ui-monospace, "Geist Mono", monospace`;
                ctx.textAlign = "center";
                ctx.textBaseline = "top";
                ctx.fillStyle = isActive ? COLOR_ACCENT : COLOR_LABEL;
                ctx.fillText(
                  node.label,
                  sx,
                  sy + r + NODE_LABEL_OFFSET_PX * pixelRatio,
                );
              }

              ctx.restore();
              ctx.globalAlpha = 1;
            }}
            linkCanvasObjectMode={() => "after"}
            linkCanvasObject={(l: LinkObject, ctx, globalScale) => {
              if (!showRelationLabels) return;
              const link = l as GLink;
              const start = link.source as unknown as GNode;
              const end = link.target as unknown as GNode;
              if (typeof start !== "object" || typeof end !== "object") return;
              if (
                start.x == null ||
                start.y == null ||
                end.x == null ||
                end.y == null
              )
                return;
              const incident = isLinkIncident(l);
              const dim = activeId != null && !incident;
              const rel = { x: end.x - start.x, y: end.y - start.y };
              let angle = Math.atan2(rel.y, rel.x);
              if (angle > Math.PI / 2) angle = -(Math.PI - angle);
              if (angle < -Math.PI / 2) angle = -(-Math.PI - angle);
              // Anchor the label to the ACTUAL rendered curve. For parallel
              // edges force-graph draws a quadratic bezier and stores its control
              // point on link.__controlPoints; the curve's midpoint (t=0.5) is
              // 0.25*start + 0.5*cp + 0.25*end. Using that — instead of a hand
              // rolled perpendicular offset whose sign didn't match the library —
              // keeps each parallel edge's label sitting on its own curve rather
              // than drifting to the wrong side.
              const cps = (
                link as unknown as { __controlPoints?: number[] | null }
              ).__controlPoints;
              const mid =
                cps && cps.length === 2
                  ? {
                      x: 0.25 * start.x + 0.5 * cps[0] + 0.25 * end.x,
                      y: 0.25 * start.y + 0.5 * cps[1] + 0.25 * end.y,
                    }
                  : {
                      x: (start.x + end.x) / 2,
                      y: (start.y + end.y) / 2,
                    };
              const label = link.label.toUpperCase();
              const fs = LINK_LABEL_FONT_SIZE / globalScale;
              ctx.font = `${fs}px ui-monospace, "Geist Mono", monospace`;
              const tw2 = ctx.measureText(label).width;
              const linkScreenLength =
                Math.sqrt(rel.x * rel.x + rel.y * rel.y) * globalScale;
              const labelScreenWidth = tw2 * globalScale;
              if (
                linkScreenLength <
                Math.max(
                  MIN_LINK_LABEL_SCREEN_LENGTH,
                  labelScreenWidth + LINK_LABEL_SCREEN_PADDING,
                )
              ) {
                return;
              }
              const bw = tw2 + fs * 0.9;
              const bh = fs + fs * 0.7;
              ctx.save();
              ctx.globalAlpha = dim ? 0.25 : 1;
              ctx.translate(mid.x, mid.y);
              ctx.rotate(angle);
              ctx.fillStyle = COLOR_LABEL_BG;
              ctx.strokeStyle = incident ? COLOR_ACCENT : COLOR_LABEL_BORDER;
              ctx.lineWidth = 1 / globalScale;
              ctx.beginPath();
              ctx.roundRect(-bw / 2, -bh / 2, bw, bh, 3 / globalScale);
              ctx.fill();
              ctx.stroke();
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              ctx.fillStyle = incident ? COLOR_ACCENT_2 : COLOR_LABEL;
              ctx.fillText(label, 0, 0);
              ctx.restore();
            }}
            d3VelocityDecay={0.35}
            cooldownTime={6000}
            onEngineStop={clampFit}
            enableNodeDrag
            onNodeDragEnd={(node) => {
              if (node.x != null && node.y != null) {
                node.fx = node.x;
                node.fy = node.y;
              }
            }}
          />
          </div>
          )}
        </>
      )}

      {/* Controls — hidden when parent renders its own via controlRef */}
      {!hideOverlayControls && (
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            display: "flex",
            alignItems: "center",
            gap: 6,
            zIndex: 10,
            flexWrap: "wrap",
            justifyContent: "flex-end",
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              ...GRAPH_PANEL_STYLE,
              borderRadius: 6,
              padding: "4px",
              fontSize: 11,
              color: "var(--fg-3)",
            }}
          >
            <span
              style={{
                padding: "0 4px",
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              Labels
            </span>
            <button
              type="button"
              className={`btn btn-ghost !py-1 !px-2 !text-[11px] ${showNodeLabels ? "!text-accent !border-accent-line" : ""}`}
              aria-pressed={showNodeLabels}
              onClick={() => setShowNodeLabels((value) => !value)}
            >
              Nodes
            </button>
            <button
              type="button"
              className={`btn btn-ghost !py-1 !px-2 !text-[11px] ${showRelationLabels ? "!text-accent !border-accent-line" : ""}`}
              aria-pressed={showRelationLabels}
              onClick={() => setShowRelationLabels((value) => !value)}
            >
              Relations
            </button>
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            style={GRAPH_CONTROL_BUTTON_STYLE}
            onClick={resetGraphView}
          >
            Reset View
          </button>
          {onClose && (
            <button
              type="button"
              className="btn btn-ghost"
              style={GRAPH_CONTROL_BUTTON_STYLE}
              onClick={onClose}
            >
              <Icon name="x" size={11} /> Close
            </button>
          )}
        </div>
      )}

      {/* Legend — knowledge / memory / entity counts + focused swatch. */}
      {graphData.nodes.length > 0 && (
        <div
          style={{
            position: "absolute",
            bottom: 12,
            left: 12,
            zIndex: 10,
            display: "flex",
            gap: 14,
            rowGap: 6,
            alignItems: "center",
            flexWrap: "wrap",
            background: "rgba(20,20,20,0.82)",
            border: "1px solid var(--line)",
            backdropFilter: "blur(6px)",
            borderRadius: 999,
            padding: "7px 12px",
            fontSize: 10,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            color: "var(--fg-3)",
            maxWidth: "calc(100% - 24px)",
          }}
        >
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <i
              style={{
                width: 9,
                height: 9,
                borderRadius: "50%",
                background: "#888",
              }}
            />
            knowledge{" "}
            <b style={{ fontFamily: "var(--mono)", color: "var(--fg)" }}>
              {typeCounts.knowledge + typeCounts.entity}
            </b>
          </span>
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <i
              style={{
                width: 9,
                height: 9,
                borderRadius: "50%",
                background: "#ffc423",
              }}
            />
            memory{" "}
            <b style={{ fontFamily: "var(--mono)", color: "var(--fg)" }}>
              {typeCounts.memory}
            </b>
          </span>
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <i
              style={{
                width: 9,
                height: 9,
                borderRadius: "50%",
                background: "var(--accent)",
                boxShadow: "0 0 0 2px var(--accent-ring)",
              }}
            />
            focused
          </span>

          {/* Provenance layer. Driven purely by what is on screen, so the
              legend stays exactly as it was on the query page, which passes no
              auxiliaryRelations, and fills in on the graph and ingestion-observe
              pages, which do. Each row is omitted when its kind has no nodes
              rather than showing a 0. */}
          {AUX_LEGEND_ROWS.map(({ type, label, color }) =>
            auxCounts[type] ? (
              <span
                key={type}
                style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
              >
                <i
                  style={{
                    // Dotted, matching the ring the canvas draws for these
                    // nodes. A solid swatch beside a dotted node is the kind of
                    // small mismatch that makes a legend stop being trusted.
                    // Bumped to 11px: a 9px circle with a 2px dotted border has
                    // too little arc for the dots to read as dots.
                    width: 11,
                    height: 11,
                    borderRadius: "50%",
                    background: COLOR_AUX_BODY,
                    border: `2px dotted ${color}`,
                    boxSizing: "border-box",
                  }}
                />
                {label}{" "}
                <b style={{ fontFamily: "var(--mono)", color: "var(--fg)" }}>
                  {auxCounts[type]}
                </b>
              </span>
            ) : null,
          )}
          {/* Edge kinds. The dash is the only thing separating a recorded link
              from a fact the model extracted, and nothing on screen said so --
              a reader had no way to know that "mentioned in" came with the data
              rather than being something the model asserted. "Auxiliary links"
              matches the backend's own name for this layer
              (`auxiliary_relations`), and is deliberately not "where it came
              from": that is true of `present_in` but not of has_comment /
              has_attachment / acted_on / relates_to, which hang off a source
              rather than being its origin. */}
          {hasAux && (
            <>
              <span
                style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                title="A relation the model extracted from the text itself"
              >
                <i
                  style={{
                    width: 14,
                    height: 0,
                    borderTop: `2px solid ${COLOR_LINK}`,
                    display: "inline-block",
                  }}
                />
                extracted relation
              </span>
              <span
                style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                title="Auxiliary links come with the source rather than being extracted from its text: which source a fact appeared in, who wrote it, its comments and attachments, and what it replies to"
              >
                <i
                  style={{
                    width: 14,
                    height: 0,
                    borderTop: `2px dashed ${COLOR_AUX_LINK}`,
                    display: "inline-block",
                  }}
                />
                Auxiliary links
              </span>
            </>
          )}
          {unresolvedSourceCount > 0 && (
            <span
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
              title="Referenced by another document but not ingested, so there is nothing to open"
            >
              <i
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: "50%",
                  background: COLOR_AUX_BODY,
                  border: `2px dashed ${COLOR_AUX_UNRESOLVED}`,
                  boxSizing: "border-box",
                }}
              />
              not ingested{" "}
              <b style={{ fontFamily: "var(--mono)", color: "var(--fg)" }}>
                {unresolvedSourceCount}
              </b>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Graph Settings Popover ──────────────────────────────────────────
// Renders a gear icon button that opens a dropdown panel with graph controls:
// node limit slider/input, label toggles, and reset view.

export function GraphSettingsPopover({
  graphRef,
  nodeLimit,
  onNodeLimitChange,
  totalNodes,
  onResetView,
  onClose: externalOnClose,
  compact = false,
}: {
  graphRef: React.MutableRefObject<SourceGraphHandle | null>;
  nodeLimit: number;
  onNodeLimitChange: (limit: number) => void;
  /** Total number of nodes available (before truncation). Used to cap the slider range. */
  totalNodes: number;
  onResetView?: () => void;
  onClose?: () => void;
  /** Compact mode for drawer headers — inline controls without the gear popover wrapper. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  // Cap the slider at the loaded node count. Anything past it is dead travel:
  // raising the limit doesn't refetch (the graph fetch is keyed on scope, not
  // node count), so a wider range would just promise data that never arrives.
  // The floor covers the mount window before totalNodes has been measured;
  // GRAPH_MAX_NODES stays as the absolute backstop.
  const sliderMax = Math.min(Math.max(totalNodes, 10), GRAPH_MAX_NODES);

  // Debounced node limit: slider updates the draft instantly for visual feedback,
  // but the actual onNodeLimitChange only fires after 500ms of inactivity.
  const [draftLimit, setDraftLimit] = useState(nodeLimit);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Sync draft when parent value changes externally (e.g. on mount).
  useEffect(() => {
    setDraftLimit(nodeLimit);
  }, [nodeLimit]);
  const handleLimitChange = useCallback(
    (v: number) => {
      setDraftLimit(v);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(
        () => onNodeLimitChange(v),
        GRAPH_DEBOUNCING_DELAY_MS,
      );
    },
    [onNodeLimitChange],
  );
  // Clean up pending debounce on unmount.
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  const effectiveNodeLimit = Math.min(Math.max(draftLimit, 10), sliderMax);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape — stop propagation so the parent drawer's Escape listener
  // doesn't also fire when the popover is open.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    // Use capture phase so we intercept before the drawer's bubble-phase listener.
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [open]);

  // Read graphRef.current lazily inside event handlers (not during render)
  // to avoid staleness on first mount before the SourceGraph useEffect runs.
  const [nodeLabelsOn, setNodeLabelsOn] = useState(true);
  const [relLabelsOn, setRelLabelsOn] = useState(true);
  // What the canvas actually drew. The budget cannot always spend its whole
  // allowance -- structural nodes are only taken where they attach to something
  // already kept -- so `min(limit, total)` overstates it, and the page's own
  // banner reports the real figure from this same handle. Both were on screen at
  // once, disagreeing.
  const [renderedNodes, setRenderedNodes] = useState<number | null>(null);

  // Sync local toggle state from the ref whenever the popover opens.
  useEffect(() => {
    if (!open) return;
    const h = graphRef.current;
    if (h) {
      setNodeLabelsOn(h.showNodeLabels);
      setRelLabelsOn(h.showRelationLabels);
      setRenderedNodes(h.renderedNodeCount);
    }
  }, [open, graphRef]);

  const handleToggleNodeLabels = () => {
    const h = graphRef.current;
    if (h) {
      h.setShowNodeLabels((v: boolean) => !v);
      setNodeLabelsOn((v) => !v);
    }
  };
  const handleToggleRelLabels = () => {
    const h = graphRef.current;
    if (h) {
      h.setShowRelationLabels((v: boolean) => !v);
      setRelLabelsOn((v) => !v);
    }
  };
  const handleResetView = () => {
    if (onResetView) onResetView();
    else graphRef.current?.resetView();
  };

  const displayedNodes = renderedNodes ?? Math.min(effectiveNodeLimit, totalNodes);


  const controlsContent = (
    <>
      {/* Node limit */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span
            style={{
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--fg-3)",
            }}
          >
            Max Nodes
          </span>
          <span
            style={{
              fontSize: 10,
              // Raising the limit re-budgets what was already fetched; it
              // never refetches, so there is no "will fetch more" state. The old
              // test (`limit > total`) could only pass below 10 nodes, since
              // sliderMax is clamped to at least 10 — so a 3-node graph read
              // "3 loaded — will fetch more" and nothing ever did.
              color: "var(--fg-4)",
            }}
          >
            {`${displayedNodes} / ${totalNodes}`}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="range"
            min={10}
            max={sliderMax}
            step={10}
            value={effectiveNodeLimit}
            onChange={(e) => handleLimitChange(parseInt(e.target.value, 10))}
            style={{ flex: 1, accentColor: "var(--accent)" }}
          />
          <input
            type="number"
            min={10}
            max={sliderMax}
            step={10}
            value={effectiveNodeLimit}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (!isNaN(v) && v >= 10 && v <= sliderMax) handleLimitChange(v);
            }}
            style={{
              width: 56,
              padding: "2px 4px",
              fontSize: 11,
              textAlign: "right",
              background: "var(--bg)",
              border: "1px solid var(--line-2)",
              borderRadius: 4,
              color: "var(--fg)",
              outline: "none",
            }}
          />
        </div>
      </div>

      {/* Divider */}
      <div style={{ borderTop: "1px solid var(--line-2)", margin: "2px 0" }} />

      {/* Label toggles */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "var(--fg-3)",
            marginRight: "auto",
          }}
        >
          Labels
        </span>
        <button
          type="button"
          className={`btn btn-ghost !py-1 !px-2 !text-[11px] ${nodeLabelsOn ? "!text-accent !border-accent-line" : ""}`}
          aria-pressed={nodeLabelsOn}
          onClick={handleToggleNodeLabels}
        >
          Nodes
        </button>
        <button
          type="button"
          className={`btn btn-ghost !py-1 !px-2 !text-[11px] ${relLabelsOn ? "!text-accent !border-accent-line" : ""}`}
          aria-pressed={relLabelsOn}
          onClick={handleToggleRelLabels}
        >
          Relations
        </button>
      </div>

      {/* Actions */}
      <div
        style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}
      >
        <button
          type="button"
          className="btn btn-ghost"
          style={{ ...GRAPH_CONTROL_BUTTON_STYLE, flex: 1 }}
          onClick={handleResetView}
        >
          Reset View
        </button>
        {externalOnClose && (
          <button
            type="button"
            className="btn btn-ghost"
            style={{ ...GRAPH_CONTROL_BUTTON_STYLE, flex: 1 }}
            onClick={externalOnClose}
          >
            <Icon name="x" size={11} /> Close
          </button>
        )}
      </div>
    </>
  );

  if (compact) {
    // Inline mode for drawer headers — just the gear button + popover
    return (
      <div
        ref={popoverRef}
        style={{ position: "relative", display: "inline-flex" }}
      >
        <button
          type="button"
          className="icon-btn"
          title="Graph settings"
          aria-label="Graph settings"
          onClick={() => setOpen((v) => !v)}
          style={{ padding: 4 }}
        >
          <Icon name="sliders" size={14} />
        </button>
        {open && (
          <div
            style={{
              position: "absolute",
              top: "100%",
              right: 0,
              marginTop: 4,
              width: 220,
              padding: 10,
              display: "flex",
              flexDirection: "column",
              gap: 8,
              ...GRAPH_PANEL_STYLE,
              borderRadius: 8,
              zIndex: 50,
            }}
          >
            {controlsContent}
          </div>
        )}
      </div>
    );
  }

  // Full mode for Brain tab header
  return (
    <div
      ref={popoverRef}
      style={{ position: "relative", display: "inline-flex" }}
    >
      <button
        type="button"
        className="btn btn-ghost graph-toolbar-toggle !py-1.5 !px-3 !text-[12px]"
        title="Graph settings"
        aria-label="Graph settings"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="sliders" size={12} /> Settings
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            marginTop: 4,
            width: 240,
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            ...GRAPH_PANEL_STYLE,
            borderRadius: 8,
            zIndex: 50,
          }}
        >
          {controlsContent}
        </div>
      )}
    </div>
  );
}
