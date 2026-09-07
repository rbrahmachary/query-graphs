// Highlight rules — the plan-highlighting heuristics used by the loader.
//
// These are loader-side policy: the loader applies them at load time to bake each node's highlight
// (costly / high-volume scan, cardinality misestimate, runtime / memory hotspot) plus its human-
// readable reason and proportional heat shade. The layout and rendering stages just display the
// baked result, keeping them database-agnostic. This module is pure (no React, no DOM).
//
// The thresholds are adjustable at render time: a loader packages these heuristics into a generic
// `PlanInsights` capability (see `createInsightsCapability`) that the UI drives — the renderer draws a
// slider per threshold and calls the capability's `rehighlight` to re-bake the tree with new values.
// Because the recompute lives here (loader-side) and is exposed only through that opaque capability,
// the rendering stage stays database-agnostic even while the highlights are live-tunable.

import type {TreeNode, InsightsThreshold, InsightsRule, PlanInsights, PropertyStyle} from "../tree-description";
import {visitTreeNodes, allChildren} from "../tree-description";
import {formatMetric, formatBytes} from "./loader-utils";

// The numeric thresholds behind the highlight rules, in natural units (rows, a ratio, a percentage).
// Seeded from `DEFAULT_THRESHOLDS`; the UI can override any of them live (see `createInsightsCapability`).
export interface HighlightThresholds {
    // Costly scan: a scan must read at least this many rows before its selectivity is even considered.
    costlyScanMinProcessed: number;
    // Costly scan: processed rows per matched row at or above which the scan is flagged (a zero-match
    // scan is always costly, independent of this ratio).
    costlyScanSelectivityRatio: number;
    // High-volume scan: a scan reads at least this many rows, regardless of selectivity. Catches the
    // "massive but efficient" reads a costly scan misses (all rows matched, but the sheer volume is
    // itself worth calling out as an optimization target).
    highVolumeScanMinProcessed: number;
    // Cardinality misestimate: the larger of estimate/actual must clear this floor to highlight.
    cardinalityFloor: number;
    // Cardinality misestimate: estimate and actual are a "mismatch" when they differ by this factor.
    cardinalityRatio: number;
    // Runtime hotspot: an operator using at least this percentage of the plan's total CPU cycles.
    runtimeHotspotPercent: number;
    // Memory hotspot: an operator holding at least this percentage of the plan's total peak memory.
    memoryHotspotPercent: number;
}

export const DEFAULT_THRESHOLDS: HighlightThresholds = {
    costlyScanMinProcessed: 1_000_000,
    costlyScanSelectivityRatio: 100,
    // A scan reading 100M+ rows is "high volume" regardless of how many it kept — big enough to be
    // worth a look on its own.
    highVolumeScanMinProcessed: 100_000_000,
    cardinalityFloor: 100_000,
    cardinalityRatio: 10,
    runtimeHotspotPercent: 5,
    // Memory concentrates in fewer operators than CPU does, so use a higher default share before
    // flagging — otherwise nearly every operator on a small plan would light up.
    memoryHotspotPercent: 20,
};

// Whether a cardinality estimate and its measured actual "mismatch": they differ by more than the
// configured ratio AND the larger side clears the absolute floor. The floor keeps a 36-vs-0 miss
// from highlighting like a 540M-vs-0 one (a >ratio difference is trivially true whenever actual is 0).
export function isCardinalityMismatch(estimate: number, actual: number, t: HighlightThresholds): boolean {
    return (
        Math.max(estimate, actual) >= t.cardinalityFloor &&
        (estimate > actual * t.cardinalityRatio || actual > estimate * t.cardinalityRatio)
    );
}

// Whether a scan is "costly": it reads a meaningful volume and keeps few of those rows. A zero-match
// scan (read everything, kept nothing) is the extreme case and always counts once the volume floor
// is met.
export function isCostlyScan(processedRows: number, rowsMatching: number, t: HighlightThresholds): boolean {
    return (
        processedRows >= t.costlyScanMinProcessed &&
        (rowsMatching === 0 || processedRows >= rowsMatching * t.costlyScanSelectivityRatio)
    );
}

// Whether a scan is "high volume": it read at least the configured number of rows, regardless of how
// selective it was. Orthogonal to `isCostlyScan` (which is about selectivity waste) — a scan can be
// high volume without being costly (all rows matched) and vice versa.
export function isHighVolumeScan(processedRows: number, t: HighlightThresholds): boolean {
    return processedRows >= t.highVolumeScanMinProcessed;
}

// The hover-tooltip reason for a high-volume scan, baked onto the node by the loader.
export function highVolumeScanReason(processedRows: number): string {
    return (
        `High-volume scan: read ${formatMetric(processedRows)} rows. Even efficient, a read this large ` +
        `dominates the plan's cost — worth checking whether it can be filtered earlier or narrowed.`
    );
}

// The hover-tooltip reason for a costly (inefficient) scan. `processed-rows` is billed at row-group
// granularity, so a low match-per-processed ratio means many row groups were read to return few rows.
export function costlyScanReason(processedRows: number, rowsMatching: number): string {
    return (
        `Inefficient scan: billed ${formatMetric(processedRows)} rows (whole row groups), ` +
        `only ${formatMetric(rowsMatching)} matched the restrictions — few matches per row group read.`
    );
}

// The hover-tooltip reason for a runtime (CPU) hotspot; `pct` is the operator's rounded share of the
// plan's total CPU cycles.
export function runtimeHotspotReason(cpuCycles: number, pct: number): string {
    return `Runtime CPU hotspot: used ${formatMetric(cpuCycles)} CPU cycles — ${pct}% of the plan's total runtime.`;
}

// The hover-tooltip reason for a memory hotspot; `pct` is the operator's rounded share of the plan's
// total peak memory.
export function memoryHotspotReason(bytes: number, pct: number): string {
    return `Memory hotspot: held ${formatBytes(bytes)} — ${pct}% of the plan's total peak memory.`;
}

// A proportional "heatmap" shade: interpolate lightness from `lightStart` (a negligible share) down to
// `lightEnd` (essentially the whole plan) by `ratio`, at a fixed hue/saturation. The costly-scan,
// runtime, and memory heatmaps differ only in their hue and lightness endpoints, so they share this.
function heatShade(hue: number, saturation: number, lightStart: number, lightEnd: number, ratio: number): string {
    const l = (lightStart + (lightEnd - lightStart) * ratio).toFixed(3);
    return `hsl(${hue}, ${saturation}%, ${l}%)`;
}

// The proportional red shade for a costly scan, darker the larger this scan's share of all rows read by
// the plan's scans. Lightness runs from 98% (a negligible share — barely tinted) down to 82% (the scan
// that read essentially everything); both ends are kept light so even the heaviest reads as a soft
// heatmap red, not a saturated error color. `processedTotal` is the summed processed-rows across every
// scan; when it is non-positive (no runtime stats) there is nothing to scale against, so fall back to
// the lightest shade.
export function costlyScanShade(processedRows: number, processedTotal: number): string {
    const ratio = processedTotal > 0 ? processedRows / processedTotal : 0;
    return heatShade(0, 100, 98, 82, ratio);
}

// The proportional violet shade for a runtime (CPU) hotspot, darker the larger this operator's share of
// the plan's total CPU cycles. A distinct hue from the magenta cardinality-misestimate edge highlight,
// so the two rules never read alike. Baked by the loader's `colorRelativeExecutionTime`.
export function runtimeHotspotShade(ratio: number): string {
    return heatShade(265, 70, 95, 72, ratio);
}

// The proportional orange shade for a memory hotspot, darker the larger this operator's share of the
// plan's total peak memory (the memory analog of the violet CPU heatmap). Orange (hue 28) is the one
// open "warning heat" slot in the palette, disambiguated by the legend, the tinted `memory-bytes` row,
// and the hover tooltip. Baked by the loader's `colorRelativeMemory`.
export function memoryHotspotShade(ratio: number): string {
    return heatShade(28, 90, 95, 72, ratio);
}

// The hover-tooltip reason for a node whose output projects a duplicate column name.
export function duplicateColumnsReason(names: string[]): string {
    return `Duplicate output column name${names.length > 1 ? "s" : ""}: ${names.join(", ")}.`;
}

// One editable numeric input in the rules footer, bound to a single `HighlightThresholds` field.
interface ThresholdField {
    key: keyof HighlightThresholds;
    label: string;
    // Suffix shown after the input (e.g. "×", "%"). Omitted for a plain row count.
    unit?: string;
    min: number;
    step: number;
}

// Metadata describing a highlight rule for the footer legend/editor: its label, the swatch class
// mirroring its node/edge color, a one-line explanation, and any editable thresholds. Rules with no
// `fields` are boolean facts (an index exists / was used), not tunable heuristics. `legend` / `summary`
// control where the category surfaces in the panel (see the matching `InsightsRule` fields), so the
// renderer draws the legend and summary generically without knowing the taxonomy.
interface HighlightRule {
    key: string;
    label: string;
    swatchClass: string;
    description: string;
    fields: ThresholdField[];
    // Appears in the top legend (countable / drill-into) vs. footer-only (edge- or list-level).
    legend: boolean;
    // Singular / plural nouns for the one-line summary header; omitted → not counted in the summary.
    summary?: {singular: string; plural: string};
}

// Order matters: the panel renders the legend and the summary by filtering this list in place, so the
// order here is the display order for both. Node categories (shown in the legend) come first in
// precedence order, then the list-only hotspots, then the edge-level cardinality rule.
const HIGHLIGHT_RULES: HighlightRule[] = [
    {
        key: "costly-scan",
        label: "Inefficient scan",
        swatchClass: "qg-swatch-costly-scan",
        description:
            "A scan billed far more rows than matched its restrictions — whole row groups were read " +
            "to return few rows (low selectivity).",
        fields: [
            {key: "costlyScanMinProcessed", label: "Min processed", min: 0, step: 100_000},
            {key: "costlyScanSelectivityRatio", label: "Processed ↔ matched", unit: "×", min: 1, step: 5},
        ],
        legend: true,
        summary: {singular: "inefficient scan", plural: "inefficient scans"},
    },
    {
        key: "high-volume-scan",
        label: "High-volume scan",
        swatchClass: "qg-swatch-high-volume-scan",
        description:
            "A scan read a very large number of rows — even if it kept most of them, the sheer volume " +
            "dominates the plan's cost and is worth a look (can it be filtered earlier or read less?).",
        fields: [{key: "highVolumeScanMinProcessed", label: "Min processed", min: 0, step: 10_000_000}],
        legend: true,
        summary: {singular: "high-volume scan", plural: "high-volume scans"},
    },
    {
        key: "index-rec",
        label: "Index recommendation",
        swatchClass: "qg-swatch-index-rec",
        description:
            "The optimizer flagged a column as an index-recommendation candidate — analyze the query " +
            "traffic patterns before building the index; it's a candidate, not a directive.",
        fields: [],
        legend: true,
        summary: {singular: "index recommendation", plural: "index recommendations"},
    },
    {
        key: "duplicate-columns",
        label: "Duplicate output columns",
        swatchClass: "qg-swatch-duplicate-columns",
        description:
            "This operator's output projects the same column name more than once — often a sign of an " +
            "over-broad or accidentally repeated projection worth double-checking.",
        fields: [],
        legend: true,
        summary: {singular: "duplicate-column node", plural: "duplicate-column nodes"},
    },
    {
        key: "index-used",
        label: "Index used",
        swatchClass: "qg-swatch-index-used",
        description: "The scan used an existing index — informational, not a guarantee the plan is optimal.",
        fields: [],
        legend: true,
    },
    {
        key: "runtime-hotspot",
        label: "Runtime CPU hotspot",
        swatchClass: "qg-swatch-runtime-hotspot",
        description: "An operator consumed a large share of the plan's total CPU cycles.",
        fields: [{key: "runtimeHotspotPercent", label: "Runtime share", unit: "%", min: 0, step: 1}],
        legend: false,
        summary: {singular: "CPU hotspot", plural: "CPU hotspots"},
    },
    {
        key: "memory-hotspot",
        label: "Memory hotspot",
        swatchClass: "qg-swatch-memory-hotspot",
        description: "An operator held a large share of the plan's total peak memory.",
        fields: [{key: "memoryHotspotPercent", label: "Memory share", unit: "%", min: 0, step: 1}],
        legend: false,
        summary: {singular: "memory hotspot", plural: "memory hotspots"},
    },
    {
        key: "cardinality",
        label: "Cardinality misestimate",
        swatchClass: "qg-swatch-cardinality",
        description: "The optimizer's row estimate diverged sharply from the actual row count on an edge.",
        fields: [
            {key: "cardinalityFloor", label: "Min rows", min: 0, step: 10_000},
            {key: "cardinalityRatio", label: "Estimate ↔ actual", unit: "×", min: 1, step: 1},
        ],
        legend: false,
    },
];

// The subset of `TreeNode` fields recomputed from thresholds. Assigned back onto the node by `rehighlight`.
interface NodeDisplay {
    highlightNode?: "costly-scan" | "high-volume-scan" | "index-rec" | "index-used";
    highlightReason?: string;
    costlyScan?: boolean;
    costlyScanColor?: string;
    highVolumeScan?: boolean;
    nodeColor?: string;
    memoryColor?: string;
    edgeClass?: string;
    edgeReason?: string;
    // Generic category membership + issue flag, so the layout/render stages never encode the taxonomy.
    insightCategories?: string[];
    isIssue?: boolean;
    // Per-property presentation hints for the renderer (see `TreeNode.propertyStyles`), plus two static
    // display fields lifted out of the raw property map so the panel needn't read property names.
    propertyStyles?: Map<string, PropertyStyle>;
    operatorId?: string;
    scanTableName?: string;
}

// Recompute a node's threshold-dependent display from its raw signals. Reproduces exactly what the
// loader bakes at load time, but from the given (possibly UI-adjusted) thresholds, so a threshold edit
// re-highlights without reloading the plan.
//
// Precedence for the node color is costly-scan > high-volume-scan > index-rec > index-used; the
// runtime-hotspot tint is orthogonal (it colors the node label / cpu-cycles row) and its explanation is
// appended to any existing reason. On the edge, a costly scan's reason overrides a cardinality
// misestimate's.
function deriveNodeDisplay(
    node: TreeNode,
    t: HighlightThresholds,
    planCpuTotal: number,
    planProcessedTotal: number,
    planMemoryTotal: number,
): NodeDisplay {
    const display: NodeDisplay = {};

    // Costly scan (top-precedence node color).
    const costly =
        typeof node.scanProcessedRows === "number" &&
        typeof node.scanRowsMatching === "number" &&
        isCostlyScan(node.scanProcessedRows, node.scanRowsMatching, t);
    let costlyReason: string | undefined;
    if (costly) {
        costlyReason = costlyScanReason(node.scanProcessedRows!, node.scanRowsMatching!);
        display.highlightNode = "costly-scan";
        display.highlightReason = costlyReason;
        display.costlyScan = true;
        // Shade the node box proportionally to this scan's share of all rows the plan's scans read,
        // the same heatmap the loader bakes (see `shadeCostlyScans` in hyper.ts).
        display.costlyScanColor = costlyScanShade(node.scanProcessedRows!, planProcessedTotal);
    } else if (typeof node.scanProcessedRows === "number" && isHighVolumeScan(node.scanProcessedRows, t)) {
        // High-volume scan: less severe than a costly scan (so it only claims the node when the scan
        // isn't costly), but more prominent than the index categories, so it wins the fill over them.
        // An index recommendation on the same scan still shows on the border (see `qg-node-index-rec-border`).
        display.highlightNode = "high-volume-scan";
        display.highlightReason = highVolumeScanReason(node.scanProcessedRows);
        display.highVolumeScan = true;
    } else if (node.baseHighlight) {
        // Fall back to the non-threshold node category (index recommendation or index used).
        display.highlightNode = node.baseHighlight;
        display.highlightReason = node.baseHighlightReason;
    }

    // Cardinality on the incoming edge. The edge label shows only the bare "actual/estimate" numbers,
    // so always spell them out as a hover tooltip; when they diverge sharply, highlight the edge and
    // append the misestimate explanation below the counts.
    if (typeof node.cardEstimate === "number" && typeof node.cardActual === "number") {
        const rowsTip = `Actual rows: ${formatMetric(node.cardActual)}, Est. rows: ${formatMetric(node.cardEstimate)}`;
        display.edgeReason = rowsTip;
        if (isCardinalityMismatch(node.cardEstimate, node.cardActual, t)) {
            display.edgeClass = "qg-label-highlighted";
            const dir = node.cardEstimate > node.cardActual ? "over-estimated" : "under-estimated";
            // Scans report the matched-restrictions count as their "actual"; generic operators report
            // measured output. Word the two cases accordingly.
            const tail = node.cardIsScan
                ? `estimated ${formatMetric(node.cardEstimate)} rows, ${formatMetric(node.cardActual)} matched the restrictions.`
                : `estimated ${formatMetric(node.cardEstimate)} rows, actual ${formatMetric(node.cardActual)}.`;
            const subject = node.cardIsScan ? "this scan's output" : "this operator's output";
            display.edgeReason = `${rowsTip}\nCardinality misestimate: the optimizer ${dir} ${subject} — ${tail}`;
        }
    }
    // A costly scan always highlights the edge; append its reason below any row-count/misestimate text.
    if (costly) {
        display.edgeClass = "qg-label-highlighted";
        display.edgeReason = display.edgeReason ? `${display.edgeReason}\n${costlyReason}` : costlyReason;
    }

    // Duplicate output column names — a static per-plan fact (not threshold-dependent), baked by the
    // loader. Appended before the CPU / memory reasons so the tooltip reads scan → duplicate → cpu → mem.
    if (node.duplicateColumns && node.duplicateColumns.length > 0) {
        const dupReason = duplicateColumnsReason(node.duplicateColumns);
        display.highlightReason = display.highlightReason ? `${display.highlightReason}\n${dupReason}` : dupReason;
    }

    // Runtime hotspot (orthogonal violet tint on the node label / cpu-cycles row). A distinct hue
    // from the magenta cardinality-misestimate edge highlight, so the two rules never read alike.
    if (typeof node.cpuTime === "number" && planCpuTotal > 0) {
        const ratio = node.cpuTime / planCpuTotal;
        if (ratio >= t.runtimeHotspotPercent / 100) {
            display.nodeColor = runtimeHotspotShade(ratio);
            const pct = Math.round(ratio * 100);
            const cpuReason = runtimeHotspotReason(node.cpuTime, pct);
            // Each reason on its own line so multiple findings on one node stay legible.
            display.highlightReason = display.highlightReason ? `${display.highlightReason}\n${cpuReason}` : cpuReason;
            // Only append to a *highlighted* edge (mismatch / costly), not to the plain row-count
            // tooltip that every cardinality edge now carries — otherwise the CPU note would leak onto
            // ordinary edges. Gate on `edgeClass` rather than the (now always-set) `edgeReason`.
            if (display.edgeClass) display.edgeReason = `${display.edgeReason}\n${cpuReason}`;
        }
    }

    // Memory hotspot (orthogonal orange tint on the node label / memory-bytes row). Independent of the
    // CPU hotspot — an operator can be both — so it gets its own `memoryColor`; the label shows the CPU
    // tint first (see QueryNode.tsx) but the memory-bytes row always carries this color. Keep the shade
    // and reason string in sync with `colorRelativeMemory` in hyper.ts.
    if (typeof node.memoryBytes === "number" && planMemoryTotal > 0) {
        const ratio = node.memoryBytes / planMemoryTotal;
        if (ratio >= t.memoryHotspotPercent / 100) {
            display.memoryColor = memoryHotspotShade(ratio);
            const pct = Math.round(ratio * 100);
            const memReason = memoryHotspotReason(node.memoryBytes, pct);
            display.highlightReason = display.highlightReason ? `${display.highlightReason}\n${memReason}` : memReason;
            if (display.edgeClass) display.edgeReason = `${display.edgeReason}\n${memReason}`;
        }
    }

    // Generic category membership + issue flag (see `TreeNode.insightCategories` / `isIssue`). Keys match
    // `HIGHLIGHT_RULES[].key`, so the panel counts / drills and the layout stage dims focus without ever
    // naming a category. A CPU / memory hotspot is identified by the tint this pass just assigned.
    const categories: string[] = [];
    if (display.costlyScan) categories.push("costly-scan");
    if (display.highVolumeScan) categories.push("high-volume-scan");
    if (node.hasIndexRec) categories.push("index-rec");
    if (node.duplicateColumns && node.duplicateColumns.length > 0) categories.push("duplicate-columns");
    if (node.hasIndexUsed) categories.push("index-used");
    if (display.nodeColor) categories.push("runtime-hotspot");
    if (display.memoryColor) categories.push("memory-hotspot");
    display.insightCategories = categories.length > 0 ? categories : undefined;
    // "Issue" = worth drawing attention to. Excludes the merely-informational used index; a runtime error
    // always qualifies. Drives focus-mode dimming and issue navigation.
    display.isIssue = Boolean(
        display.costlyScan ||
        display.highVolumeScan ||
        node.hasIndexRec ||
        (node.duplicateColumns && node.duplicateColumns.length > 0) ||
        display.nodeColor ||
        display.memoryColor ||
        node.errorMessage,
    );

    // Per-property presentation hints (see `PropertyStyle`): the loader owns the property-name vocabulary,
    // so it bakes each row's tint / shade / grouping / annotation here and the renderer just applies them.
    // Rebuilt every pass because several tints depend on the (tunable) scan / hotspot verdicts above.
    const propertyStyles = new Map<string, PropertyStyle>();
    const styleRow = (key: string, patch: PropertyStyle) => propertyStyles.set(key, {...propertyStyles.get(key), ...patch});
    for (const [key, value] of node.properties ?? []) {
        // `table-metadata` renders as a grouped header + indented sub-items (the loader packs the sub-items
        // as newline-separated `label: value` lines).
        if (key === "table-metadata") styleRow(key, {grouped: true});
        // An index recommendation gets an amber emphasis; a *used* index gets informational blue, but only
        // when one was actually used (value != "no").
        else if (key === "index-rec") styleRow(key, {className: "qg-prop-emphasized"});
        else if (key === "index-used" && value !== "no") styleRow(key, {className: "qg-prop-index-used"});
        // The loader-added duplicate-columns list carries the node's rose warning tint.
        else if (key === "duplicate-columns") styleRow(key, {className: "qg-prop-duplicate-columns"});
        // A hybrid / vector search node tints its `function` row teal to match the insights legend accent.
        else if (node.vectorSearch && key === "function") styleRow(key, {className: "qg-prop-vector-search"});
        // The benign "(likely early probe)" annotation on a 0-row scan is tinted green, split from the "0".
        else if (key === "processed-rows" && value.includes("(likely early probe)"))
            styleRow(key, {annotation: "(likely early probe)"});
    }
    // Tint the cpu-cycles / memory-bytes rows with the same runtime-violet / memory-orange heat as the node
    // label, so an expanded node matches its collapsed shade.
    if (node.properties?.has("cpu-cycles") && display.nodeColor) styleRow("cpu-cycles", {background: display.nodeColor});
    if (node.properties?.has("memory-bytes") && display.memoryColor) styleRow("memory-bytes", {background: display.memoryColor});
    // On a costly scan, flag the processed-rows / rows-matching rows in proportional red; on a high-volume
    // (but not costly) scan, tint processed-rows indigo instead.
    if (display.costlyScan) {
        for (const key of ["processed-rows", "rows-matching"]) {
            if (node.properties?.has(key)) styleRow(key, {className: "qg-prop-costly-scan", background: display.costlyScanColor});
        }
    } else if (display.highVolumeScan && node.properties?.has("processed-rows")) {
        styleRow("processed-rows", {className: "qg-prop-high-volume-scan"});
    }
    display.propertyStyles = propertyStyles.size > 0 ? propertyStyles : undefined;

    // Static display fields the panel needs, lifted out of the raw property map so the render stage never
    // reads a database-specific property name.
    display.operatorId = node.properties?.get("operator-id");
    display.scanTableName = node.properties?.get("table-name");

    return display;
}

// The footer documentation, associating each rule with the threshold keys that tune it (empty for the
// boolean-fact rules like "index used"). Shared by the adjustable and static capabilities.
function insightsRules(): InsightsRule[] {
    return HIGHLIGHT_RULES.map((rule) => ({
        key: rule.key,
        label: rule.label,
        swatchClass: rule.swatchClass,
        description: rule.description,
        thresholdKeys: rule.fields.map((f) => f.key),
        legend: rule.legend,
        summary: rule.summary,
    }));
}

// A docs-only insights capability: it surfaces the panel (legend + per-operator lists) but exposes no
// adjustable thresholds and a no-op `rehighlight`. Used for trees whose highlights can't be meaningfully
// re-derived from a single set of plan-wide totals — e.g. an optimizer-steps tree that stitches several
// independent sub-plans, each baked against its own totals.
export function staticInsightsCapability(): PlanInsights {
    return {thresholds: [], rules: insightsRules(), rehighlight: () => {}};
}

// Package the highlight heuristics into the generic `PlanInsights` capability a loader attaches to its
// `TreeDescription`. The renderer stays database-agnostic: it reads `thresholds` to draw the sliders and
// `rules` for the footer legend, and calls `rehighlight` (which owns all the database-specific logic
// here) whenever the user tunes a knob. `planCpuTotal` / `planProcessedTotal` / `planMemoryTotal` are the
// plan-wide totals the recompute needs; the loader passes the values it measured during conversion.
export function createInsightsCapability(
    root: TreeNode,
    planCpuTotal: number,
    planProcessedTotal: number,
    planMemoryTotal: number,
): PlanInsights {
    // Flatten the tunable fields into generic slider descriptors, seeded with the default values.
    const thresholds: InsightsThreshold[] = HIGHLIGHT_RULES.flatMap((rule) =>
        rule.fields.map((f) => ({
            key: f.key,
            label: f.label,
            value: DEFAULT_THRESHOLDS[f.key],
            min: f.min,
            step: f.step,
            unit: f.unit,
        })),
    );
    const rules = insightsRules();
    const rehighlight = (values: Record<string, number>) => {
        // The generic values map is keyed by our threshold field names, so merging over the defaults
        // yields a full `HighlightThresholds` (any knob the UI omits keeps its default).
        const t: HighlightThresholds = {...DEFAULT_THRESHOLDS, ...values};
        visitTreeNodes(
            root,
            (node) => {
                const d = deriveNodeDisplay(node, t, planCpuTotal, planProcessedTotal, planMemoryTotal);
                // Assign every field (even when undefined) so a highlight that no longer applies under
                // the new thresholds is cleared, not left stale from a previous pass.
                node.highlightNode = d.highlightNode;
                node.highlightReason = d.highlightReason;
                node.costlyScan = d.costlyScan;
                node.costlyScanColor = d.costlyScanColor;
                node.nodeColor = d.nodeColor;
                node.memoryColor = d.memoryColor;
                node.edgeClass = d.edgeClass;
                node.edgeReason = d.edgeReason;
                node.insightCategories = d.insightCategories;
                node.isIssue = d.isIssue;
                node.propertyStyles = d.propertyStyles;
                node.operatorId = d.operatorId;
                node.scanTableName = d.scanTableName;
            },
            allChildren,
        );
    };
    return {thresholds, rules, rehighlight};
}
