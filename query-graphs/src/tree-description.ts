export type IconName =
    | "run-query-symbol"
    | "filter-symbol"
    | "groupby-symbol"
    | "sort-symbol"
    | "limit-symbol"
    | "inner-join-symbol"
    | "left-join-symbol"
    | "right-join-symbol"
    | "full-join-symbol"
    | "table-symbol"
    | "temp-table-symbol"
    | "virtual-table-symbol"
    | "const-table-symbol";

// A loader-supplied presentation hint for a single property row, keyed by property name in
// `TreeNode.propertyStyles`. Lets the renderer tint, shade, group, and annotate property rows without
// ever branching on database-specific property names or values — the loader (which owns that
// vocabulary) bakes the hint and the renderer applies whatever fields are present. Re-baked on tuning
// because some tints (costly / high-volume scan, CPU / memory heat) are threshold-dependent.
export interface PropertyStyle {
    // Extra CSS class(es) for the row (an emphasis or heat tint).
    className?: string;
    // A literal CSS color for the row background (a baked proportional heat shade).
    background?: string;
    // Render the value as a header row followed by one indented sub-item per newline-separated
    // `label: value` line, instead of a single value.
    grouped?: boolean;
    // A trailing substring of the value to render in its own "benign annotation" span, tinted apart
    // from the rest of the value.
    annotation?: string;
}

// Must be a `type` instead of the usual `interface`.
// xyflow's `Node<NodeData>` requires NodeData to satisfy `Record<string, unknown>` and
// TypeScript only infers that implicit index signature for type aliases, not interfaces.
// Also see official docs at https://reactflow.dev/learn/advanced-use/typescript#custom-nodes
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type TreeNode = {
    // The displayed node name
    name?: string;
    // Color applied to node rects
    nodeColor?: string;
    // The name of the icon rendered for this node
    icon?: IconName;
    // The color for the icon
    iconColor?: string;
    // Rendered in the tooltip
    properties?: Map<string, string>;
    // Full relevant-first column name lists for truncated column-preview properties (keyed by the same
    // property name, e.g. `columns`, `outputs`). Present only when the preview was elided; lets the UI
    // progressively reveal the hidden columns when the `... [n]` marker is clicked.
    columnLists?: Map<string, string[]>;
    // Loader-supplied per-property presentation hints (keyed by property name; see `PropertyStyle`).
    // Lets the renderer style property rows — emphasis/heat tints, heat-map backgrounds, grouped
    // sub-lists, benign annotations — without knowing any database-specific property names. Baked by the
    // loader's insights `rehighlight`; absent when the node has no styled rows.
    propertyStyles?: Map<string, PropertyStyle>;
    // Colors the whole node based on its content so it can be spotted while collapsed, without
    // expanding to see the properties. The category (chosen by precedence: costly-scan > index-rec >
    // index-used) drives the highlight color, matching the corresponding property-row highlight.
    // Baked by the loader; the rendering stage just displays it.
    highlightNode?: "costly-scan" | "high-volume-scan" | "index-rec" | "index-used";
    // Human-readable explanation of why the node is highlighted (shown as a hover tooltip).
    highlightReason?: string;
    // Raw processed-rows count for a scan node (unformatted), used to total scan volume in the
    // plan-insights summary and to rank the "top offenders" list. Undefined for non-scan nodes /
    // plans without runtime statistics.
    scanProcessedRows?: number;
    // Raw rows-matching-restrictions count for a scan node (unformatted). Paired with
    // scanProcessedRows to compute the processed-to-matching ratio in the offenders list.
    scanRowsMatching?: number;
    // The scan's source type, used for the plan-insights "Scan types" breakdown. For the newer generic
    // `scan` operator this is its `type` field (e.g. `data-lake-object`); for the older per-format
    // operators it is the operator tag itself (`tablescan`, `icebergscan`, `parquetscan`, …). Only set
    // on scan nodes.
    scanType?: string;
    // A stable per-operator id from the plan (e.g. Hyper's `operator-id`), used by the insights panel to
    // disambiguate two same-named operators in its CPU / memory / error lists. Baked by the loader so the
    // panel needn't read raw property names.
    operatorId?: string;
    // The scanned relation's display name (e.g. Hyper's `table-name`), used as the label for a scan in the
    // insights "top offenders" list. Baked by the loader; falls back to `name` when absent.
    scanTableName?: string;
    // Marks a costly scan: one whose processed-rows dwarf rows-matching (low selectivity).
    // Used to highlight the costly scan's processed-rows / rows-matching property rows in light red.
    costlyScan?: boolean;
    // Proportional red shade for a costly scan's node box, darker the larger this scan's share of all
    // rows the plan's scans read (mirrors `nodeColor`'s runtime heatmap). Only set on costly scans.
    // Applied as a CSS custom property so the expanded/hover "white" state can still override it.
    costlyScanColor?: string;
    // Proportional orange shade for a memory hotspot, the memory analog of `nodeColor`'s violet CPU
    // heatmap: darker the larger this operator's share of the plan's total memory. Tints the node label
    // (when not already CPU-tinted) and the `memory-bytes` property row. Only set on memory hotspots.
    memoryColor?: string;

    // --- Per-operator metrics surfaced by the plan-insights panel ---
    // Unformatted measured figures the panel totals and ranks. Populated by the loader (currently Hyper).
    //
    // Measured CPU cycles for this operator (drives the runtime "Top operators by CPU" list).
    cpuTime?: number;
    // Measured peak memory (bytes) for this operator (drives the "Top operators by memory" list).
    memoryBytes?: number;
    // The optimizer's row estimate and the measured actual for the incoming edge (cardinality
    // misestimate). `cardIsScan` distinguishes a scan's rows-matching "actual" from a generic
    // operator's measured output, so the baked edge reason reads correctly.
    cardEstimate?: number;
    cardActual?: number;
    cardIsScan?: boolean;
    // The node category the loader determined for an index recommendation / index used, and its reason.
    // A loader-internal intermediate used while baking `highlightNode`/`highlightReason` above.
    baseHighlight?: "index-rec" | "index-used";
    baseHighlightReason?: string;
    // Category membership flags, independent of `highlightNode` (which can only show one color by
    // precedence). A single scan can belong to several categories at once — e.g. a costly scan
    // that also has an index recommendation — so the plan-insights legend counts/drills off these.
    hasIndexRec?: boolean;
    hasIndexUsed?: boolean;

    // Generic highlight-category membership, baked by the loader's insights capability: the stable
    // category keys this node belongs to (the same keys the loader lists in `PlanInsights.rules`). A node
    // can belong to several at once. The plan-insights panel counts and drills off this list, so it never
    // needs to know the database's highlight taxonomy. Re-baked whenever the thresholds change.
    insightCategories?: string[];
    // Generic "worth attention" flag, baked by the loader: true when the node is a highlighted issue (a
    // costly / high-volume scan, index recommendation, duplicate-column node, CPU / memory hotspot, or a
    // runtime error — but not a merely-informational used index). Drives focus-mode dimming (layout stage)
    // and issue navigation (insights panel) without either encoding the taxonomy. Re-baked on tuning.
    isIssue?: boolean;

    // Set on a `udtablefunction` node that performs a (hybrid / vector) search, e.g. Data Cloud's
    // `hybrid_search`. Carries the key metadata surfaced by the Hyper loader so the plan-insights panel
    // can call out the search node(s) and let the user jump to them. `hybrid` is true when the search
    // also runs a keyword (lexical) retrieval leg alongside the vector one.
    vectorSearch?: {
        function?: string;
        index?: string;
        vectorDb?: string;
        embeddingModel?: string;
        hybrid?: boolean;
    };

    // Set when this operator carries a runtime error (a failed / analyzed plan records the error on the
    // operator that raised it — often the `execution-target` root). Carries the one-line message (with the
    // SQLSTATE code prefix) so the plan-insights panel can surface it as a severe error and let the user
    // jump to the node. A query failure is the single most important thing to see, so it outranks every
    // other insight.
    errorMessage?: string;

    // Set when this node's rendered "output columns" list emits the same column name more than once
    // (e.g. an execution-target projection that references the same IU twice). Carries the duplicated
    // names, in first-seen order, so the UI can flag the node (warning border + tinted `duplicate-columns`
    // row + hover reason) and the plan-insights panel can count and jump to it. Static per plan, not
    // threshold-dependent.
    duplicateColumns?: string[];

    // Colors of a bar drawn just above the node
    // (conceptually the "outgoing" side, toward the parent).
    // Empty/undefined means no bar. Segments are drawn in array order.
    barsAbove?: string[];
    // Colors of a bar drawn just below the node
    // (conceptually the "incoming" side, toward the children).
    // Empty/undefined means no bar. Segments are drawn in array order.
    barsBelow?: string[];

    // Additional CSS classes applied to the incoming link
    edgeClass?: string;
    // Label placed on the incoming edge
    edgeLabel?: string;
    // Explanation shown as a hover tooltip on the incoming edge label (e.g. why it is highlighted).
    edgeReason?: string;
    // Width of the incoming edge
    edgeWidth?: number;
    // Colors of the incoming edge. Several colors are drawn as a gradient,
    // a single color as a solid stroke.
    edgeColors?: string[];

    // All child nodes visible by default
    children?: TreeNode[];
    // All collapsed child nodes
    collapsedChildren?: TreeNode[];
    // Whether collapsed children are shown by default
    expandedByDefault?: boolean;
};

export interface Crosslink {
    source: TreeNode;
    target: TreeNode;
}

/// One adjustable numeric knob a loader exposes for live highlight tuning, described generically so the
/// rendering stage can draw an input for it without knowing what it means. `key` is opaque to the UI: it
/// is echoed back verbatim in the `rehighlight` values map.
export interface InsightsThreshold {
    key: string;
    label: string;
    /// Current value (seeded with the loader's default; overridden as the user edits the slider).
    value: number;
    min: number;
    step: number;
    /// Suffix shown after the input (e.g. "×", "%"). Omitted for a plain row count.
    unit?: string;
}

/// One highlight category, as the insights panel sees it: its legend swatch, label, one-line
/// description, which threshold keys (if any) tune it, and where it surfaces. Loader-supplied so the
/// rendering stage carries no database-specific vocabulary — it counts nodes by matching `key` against
/// `TreeNode.insightCategories`, and draws the legend / summary / footer entirely from these fields.
export interface InsightsRule {
    /// Stable category identity, echoed on the member nodes' `TreeNode.insightCategories`. Opaque to the
    /// renderer (used only as a lookup handle / React key).
    key: string;
    label: string;
    swatchClass: string;
    description: string;
    thresholdKeys: string[];
    /// True when this category appears in the panel's top legend as a countable, drill-into-able row.
    /// Edge-level or list-only categories (e.g. a cardinality misestimate, a CPU hotspot) set this false
    /// and show only in the "How highlighting works" footer.
    legend: boolean;
    /// Singular / plural nouns for the one-line summary header (e.g. "inefficient scan" / "inefficient
    /// scans"). Present only for categories the loader wants counted in the summary; omitted → footer-only.
    summary?: {singular: string; plural: string};
}

/// A loader-supplied plan-insights capability (see `TreeDescription.insights`). The loader owns all the
/// highlight logic and vocabulary; the renderer only draws `thresholds` as sliders and `rules` as the
/// footer legend, and calls `rehighlight` when the user tunes a knob. This keeps the rendering stage
/// database-agnostic while the highlights stay live-tunable.
export interface PlanInsights {
    /// The adjustable thresholds, in display order. Empty if the loader bakes fixed highlights.
    thresholds: InsightsThreshold[];
    /// The highlight categories, for the footer legend/documentation.
    rules: InsightsRule[];
    /// Re-run the loader's highlight pass over the tree with new threshold values (keyed by
    /// `InsightsThreshold.key`), mutating the baked `TreeNode` highlight fields in place. The renderer
    /// calls this on a slider edit, then re-lays-out from the freshly-baked fields.
    rehighlight: (values: Record<string, number>) => void;
}

/// Which loader produced this tree. Lets the UI make source-specific decisions if it ever needs to,
/// without inferring the source from an incidental feature flag. Loaders that don't identify
/// themselves leave it unset. NB: the rendering stage must stay database-agnostic — gate optional UI
/// (e.g. the plan-insights panel) on a generic capability flag like `hasInsights`, not on this.
export type PlanSource = "hyper" | "postgres" | "tableau" | "json" | "xml";

export interface TreeDescription {
    /// The tree root
    root: TreeNode;
    /// The loader that produced this tree (see `PlanSource`).
    planSource?: PlanSource;
    /// Metadata about the graph; displayed in the top-level tree label
    metadata?: Map<string, string>;
    /// Additional links between indirectly related nodes
    crosslinks?: Crosslink[];
    /// Set by a loader when the tree carries plan-insights data — highlighted issues (costly / high-
    /// volume scans, index recommendations, duplicate columns) and per-operator scan / CPU / memory
    /// metrics — for the insights panel to surface. A generic capability object (see `PlanInsights`):
    /// the panel mounts on its presence and drives it entirely through this interface, keeping the
    /// rendering stage database-agnostic rather than branching on `planSource`.
    insights?: PlanInsights;
}

// A recursive helper function for walking through all nodes
export function visitTreeNodes<T>(parent: T, visitFn: (n: T) => void, childrenFn: (n: T) => T[]) {
    if (!parent) {
        return;
    }
    visitFn(parent);
    for (const child of childrenFn(parent)) {
        visitTreeNodes(child, visitFn, childrenFn);
    }
}

interface TreeLike<T extends TreeLike<T>> {
    children?: T[];
    collapsedChildren?: T[];
}

// Returns all children of a node, including collapsed children
export function allChildren<T extends TreeLike<T>>(n: T): T[] {
    return (n.children ?? []).concat(n.collapsedChildren ?? []);
}
