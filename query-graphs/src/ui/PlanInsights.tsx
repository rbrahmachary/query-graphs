import {useMemo, useState, useCallback, useRef, useEffect} from "react";
import type {ReactElement, ReactNode} from "react";
import {Panel, useReactFlow} from "@xyflow/react";
import type {TreeDescription, TreeNode, InsightsThreshold} from "../tree-description";
import {allChildren, visitTreeNodes} from "../tree-description";
import {formatMetric, formatBytes} from "../loaders/loader-utils";
import {useGraphRenderingStore} from "./store";
import type {QueryGraphNode} from "./QueryNode";
import "./PlanInsights.css";

// The ranked "Top …" lists start compact, showing this many rows, and reveal `ROWS_STEP` more each time
// the trailing "…" control is clicked (walking the full list a batch at a time).
const INITIAL_ROWS = 3;
const ROWS_STEP = 2;

// Longest offender label to render inline; longer names are trimmed with an ellipsis (the full name
// stays in the hover tooltip).
const OFFENDER_LABEL_MAX = 30;
function trimLabel(label: string): string {
    return label.length > OFFENDER_LABEL_MAX ? label.slice(0, OFFENDER_LABEL_MAX - 1).trimEnd() + "…" : label;
}

// A scan ranked in the "top offenders" list, worst-first by processed-row volume.
interface Offender {
    id: string;
    label: string;
    processed: number;
    matching?: number;
    costlyScan: boolean;
}

// An operator ranked in the "top operators by CPU" list, worst-first by CPU cycles consumed.
// `hot` is the loader's runtime-hotspot verdict (it baked a `nodeColor` violet tint on this operator).
interface CpuOp {
    id: string;
    label: string;
    cycles: number;
    hot: boolean;
}

// An operator ranked in the "top operators by memory" list, worst-first by peak memory held.
// `hot` is the loader's memory-hotspot verdict (it baked a `memoryColor` orange tint on this operator).
interface MemoryOp {
    id: string;
    label: string;
    bytes: number;
    hot: boolean;
}

// A vector / hybrid search node (e.g. Data Cloud `hybrid_search`), called out so the user can spot
// and jump to it. `label` is the index searched (falling back to the function name).
interface SearchNode {
    id: string;
    label: string;
    detail: string;
    hybrid: boolean;
}

// An operator that carries a runtime error (a failed / analyzed plan). `message` is the one-line error
// (SQLSTATE-prefixed); `label` names the operator so the user can tell where it was raised.
interface PlanError {
    id: string;
    label: string;
    message: string;
}

interface PlanInsightsProps {
    treeDescription: TreeDescription;
    // Maps each tree node to the id react-flow assigns it, so we can pan to it.
    nodeIdMapping: Map<TreeNode, string>;
}

// One row of a ranked "Top …" list: a clickable operator with a formatted metric and hover tooltip.
// `hot` applies the list's accent tint (a costly scan / CPU / memory hotspot).
interface RankedRow {
    id: string;
    label: string;
    metric: string;
    hot: boolean;
    title: string;
}

// A ranked "Top …" list (top scans / CPU / memory): a titled column of clickable rows, each showing a
// rank, trimmed label, and formatted metric, ending with an optional more/less control. The three lists
// differ only in their data, accent color, and metric formatter, so they share this one renderer. The
// `hotClass` is added to a "hot" row so its metric picks up the matching node-highlight tint (see the
// `.qg-insights-metric-*` rules in PlanInsights.css).
function RankedList({
    title,
    rows,
    hotClass,
    onSelect,
    controls,
}: {
    title: string;
    rows: RankedRow[];
    hotClass: string;
    onSelect: (id: string) => void;
    controls: ReactNode;
}): ReactElement {
    return (
        <div className="qg-insights-list">
            <div className="qg-insights-list-title">{title}</div>
            {rows.map((r, i) => (
                <button
                    key={r.id}
                    type="button"
                    className={`qg-insights-list-row${r.hot ? ` ${hotClass}` : ""}`}
                    onClick={() => onSelect(r.id)}
                    title={r.title}
                >
                    <span className="qg-insights-list-rank">{i + 1}.</span>
                    <span className="qg-insights-list-label">{trimLabel(r.label)}</span>
                    <span className="qg-insights-list-metric">{r.metric}</span>
                </button>
            ))}
            {controls}
        </div>
    );
}

// An overlay panel providing at-a-glance plan insights: a color legend, a one-line summary of
// the issues found, a "jump to next issue" navigator, and a focus toggle that dims all
// non-flagged nodes so the interesting ones stand out on large plans.
export function PlanInsights({treeDescription, nodeIdMapping}: PlanInsightsProps) {
    const reactFlow = useReactFlow<QueryGraphNode>();

    // The loader's insights capability: the highlight categories (for the footer legend) and the
    // adjustable thresholds (rendered as sliders). The renderer stays database-agnostic — it never
    // reads the meaning of a threshold key, only echoes it back through `setThreshold` / `rehighlight`.
    const insights = treeDescription.insights;

    // Live threshold values from the store. Editing a slider updates the store; QueryGraph re-bakes the
    // tree's highlight fields via `insights.rehighlight` before re-laying-out, and this walk re-runs
    // (it depends on `highlightThresholds`) so the counts and ranked lists stay in sync.
    const highlightThresholds = useGraphRenderingStore((s) => s.highlightThresholds);
    const setThreshold = useGraphRenderingStore((s) => s.setThreshold);
    const resetThresholds = useGraphRenderingStore((s) => s.resetThresholds);
    // Look up a threshold descriptor by its opaque key, so a footer rule can render the inputs for the
    // knobs it lists in `thresholdKeys`.
    const thresholdByKey = useMemo(() => {
        const m = new Map<string, InsightsThreshold>();
        for (const t of insights?.thresholds ?? []) m.set(t.key, t);
        return m;
    }, [insights]);

    // Walk the tree once, grouping node ids by highlight category and totaling the scan volume. Category
    // membership is read from the generic `insightCategories` list the loader baked onto each node (the
    // same category keys it lists in `insights.rules`), so the panel counts and drills without knowing
    // the database's taxonomy. A node can belong to several categories at once — a costly scan may also
    // carry an index recommendation and use an index — and they all count. `issueIds` collects the nodes
    // the loader flagged as an actual issue (its baked `isIssue`), which drives the "Next issue" navigation.
    const {byCategory, issueIds, totalProcessed, scans, searchNodes, scanTypes, cpus, totalCpu, mems, totalMemory, errors} =
        useMemo(() => {
            const byCategory: Record<string, string[]> = {};
            const pushCategory = (key: string, id: string) => {
                (byCategory[key] ??= []).push(id);
            };
            const issueIds: string[] = [];
            let totalProcessed = 0;
            let totalCpu = 0;
            let totalMemory = 0;
            const scans: Offender[] = [];
            const cpus: CpuOp[] = [];
            const mems: MemoryOp[] = [];
            const searchNodes: SearchNode[] = [];
            const errors: PlanError[] = [];
            // Group scan-node ids by their source type (`data-lake-object`, `tablescan`, …) for the
            // "Scan types" breakdown; the count is the list length and the ids drive click-to-drill.
            const scanTypeIds = new Map<string, string[]>();
            visitTreeNodes(
                treeDescription.root,
                (n) => {
                    if (typeof n.scanProcessedRows === "number") {
                        totalProcessed += n.scanProcessedRows;
                    }
                    if (typeof n.cpuTime === "number") {
                        totalCpu += n.cpuTime;
                    }
                    if (typeof n.memoryBytes === "number") {
                        totalMemory += n.memoryBytes;
                    }
                    const id = nodeIdMapping.get(n);
                    if (id === undefined) return;
                    // Category membership + the generic issue flag are both loader-baked. Collecting the
                    // full tree (not just the visible top-N) keeps the legend counts and issue navigation
                    // complete.
                    for (const category of n.insightCategories ?? []) pushCategory(category, id);
                    if (n.isIssue) issueIds.push(id);
                    // Label an operator by its name, tagging the operator-id when present so two same-named
                    // operators stay distinguishable. Shared by the error / CPU / memory lists below.
                    const opId = n.operatorId;
                    const opLabel = opId ? `${n.name ?? "operator"} #${opId}` : (n.name ?? "operator");
                    // A runtime error is the single most important finding: collect the errored operator(s)
                    // so the panel can call it out as a severe error and link straight to the node.
                    if (n.errorMessage) {
                        errors.push({id, label: opLabel, message: n.errorMessage});
                    }
                    // Every operator with a measured CPU figure is a CPU-list candidate. `nodeColor` is the
                    // loader's baked runtime-hotspot verdict (violet tint), so a colored operator is "hot".
                    if (typeof n.cpuTime === "number") {
                        cpus.push({id, label: opLabel, cycles: n.cpuTime, hot: !!n.nodeColor});
                    }
                    // Every operator with a measured peak-memory figure is a memory-list candidate.
                    // `memoryColor` is the loader's baked memory-hotspot verdict (orange tint).
                    if (typeof n.memoryBytes === "number") {
                        mems.push({id, label: opLabel, bytes: n.memoryBytes, hot: !!n.memoryColor});
                    }
                    if (n.scanType) {
                        const ids = scanTypeIds.get(n.scanType);
                        if (ids) ids.push(id);
                        else scanTypeIds.set(n.scanType, [id]);
                    }
                    // Every scan with a measured processed-row volume is an offender candidate.
                    if (typeof n.scanProcessedRows === "number") {
                        const matching = n.scanRowsMatching;
                        scans.push({
                            id,
                            label: n.scanTableName ?? n.name ?? "scan",
                            processed: n.scanProcessedRows,
                            matching,
                            costlyScan: !!n.costlyScan,
                        });
                    }
                    // A vector / hybrid search node (Data Cloud `hybrid_search` etc.).
                    if (n.vectorSearch) {
                        const vs = n.vectorSearch;
                        // Prefer the index searched as the primary label; the vector DB + embedding model
                        // make the informative detail line.
                        const detailParts = [vs.vectorDb, vs.embeddingModel].filter((p): p is string => !!p);
                        searchNodes.push({
                            id,
                            label: vs.index ?? vs.function ?? n.name ?? "search",
                            detail: detailParts.join(" · "),
                            hybrid: !!vs.hybrid,
                        });
                    }
                },
                allChildren,
            );
            // Rank worst-first by raw processed volume — the rows Hyper actually had to read. The full
            // sorted list is returned; the render shows the first few and reveals more on demand.
            scans.sort((a, b) => b.processed - a.processed);
            // Rank CPU / memory operators worst-first (cycles consumed / peak memory held). The full sorted
            // lists are returned: the render shows the top-N, but the baked-hotspot flags/ids already cover
            // every operator (which can extend past the top-N) for the summary and "Next issue" navigation.
            cpus.sort((a, b) => b.cycles - a.cycles);
            mems.sort((a, b) => b.bytes - a.bytes);
            // Most-frequent type first; ties broken alphabetically for a stable order.
            const scanTypes = [...scanTypeIds.entries()]
                .map(([type, ids]) => ({type, ids}))
                .sort((a, b) => b.ids.length - a.ids.length || a.type.localeCompare(b.type));
            return {byCategory, issueIds, totalProcessed, scans, searchNodes, scanTypes, cpus, totalCpu, mems, totalMemory, errors};
            // `highlightThresholds` is a dependency because the loader re-bakes the tree's highlight fields
            // (via `insights.rehighlight` in QueryGraph) when a slider changes; re-running the walk keeps the
            // category counts and issue list consistent with the freshly-baked node fields. exhaustive-deps
            // can't see this (the walk reads the mutated nodes, not the values directly), so it's kept manually.
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [treeDescription, nodeIdMapping, highlightThresholds]);

    // Node counts per highlight category, keyed by the loader's category keys. Missing keys read 0.
    const counts: Record<string, number> = {};
    for (const [key, ids] of Object.entries(byCategory)) counts[key] = ids.length;

    // Center a node in the viewport by react-flow id.
    const centerOnNode = useCallback(
        (id: string) => {
            const target = reactFlow.getNode(id);
            if (target) {
                // The graph sets `nodeOrigin={[0.5, 0]}`, so a node's `position` anchor is its
                // top-center: `position.x` is already the horizontal center (no +width/2), while
                // `position.y` is the top edge, so add half the height to reach the vertical center.
                const x = target.position.x;
                const y = target.position.y + (target.measured?.height ?? target.height ?? 0) / 2;
                reactFlow.setCenter(x, y, {zoom: 1, duration: 400});
            }
        },
        [reactFlow],
    );

    // Each category keeps its own round-robin cursor, so repeatedly clicking a legend row (or the
    // "Next issue" button) walks through that category's nodes one at a time.
    const cursorsRef = useRef<Record<string, number>>({});
    const drillInto = useCallback(
        (ids: string[], key: string) => {
            if (ids.length === 0) return;
            const next = ((cursorsRef.current[key] ?? -1) + 1) % ids.length;
            cursorsRef.current[key] = next;
            centerOnNode(ids[next]);
        },
        [centerOnNode],
    );

    // "Jump to next issue" cycles through the nodes the loader flagged as an actual issue (its baked
    // `isIssue`, collected into `issueIds` during the walk), centering each in the viewport. Which nodes
    // count is loader policy — a used index, for instance, is informational, so it is counted in the
    // legend but excluded from `isIssue` and thus from this navigation. `issueIds` already has one entry
    // per node (the walk visits each once), so no further deduplication is needed.
    const issues = issueIds;
    const [cursor, setCursor] = useState(-1);
    // Reset every navigation cursor when a different plan is loaded, so drill-down and "next issue"
    // start fresh instead of resuming at a position that referred to the previous plan's node list.
    // The `cursor` state uses React's render-phase "adjust state when a prop changes" pattern (tracking
    // the previous plan) rather than a `setState` inside an effect; the `cursorsRef` map is a plain ref,
    // so it is cleared in an effect (refs must not be written during render).
    const [prevTree, setPrevTree] = useState(treeDescription);
    // How many rows each "Top …" list currently reveals. Starts compact; the trailing "…" grows it.
    const [scansShown, setScansShown] = useState(INITIAL_ROWS);
    const [cpuShown, setCpuShown] = useState(INITIAL_ROWS);
    const [memShown, setMemShown] = useState(INITIAL_ROWS);
    if (prevTree !== treeDescription) {
        setPrevTree(treeDescription);
        setCursor(-1);
        // A new plan has different lists; collapse each back to the compact initial size.
        setScansShown(INITIAL_ROWS);
        setCpuShown(INITIAL_ROWS);
        setMemShown(INITIAL_ROWS);
    }
    const offenders = scans.slice(0, scansShown);
    const cpuOps = cpus.slice(0, cpuShown);
    const memoryOps = mems.slice(0, memShown);

    // The "… N more / … N less" controls for a ranked list: reveal the next `ROWS_STEP` entries, or
    // collapse back toward the compact `INITIAL_ROWS`. Rendered only for the directions that apply, so a
    // list capped at its full length shows just "less", and one at the initial size shows just "more".
    const revealControls = (shown: number, setShown: (u: (s: number) => number) => void, total: number) => {
        const more = Math.min(ROWS_STEP, total - shown);
        const less = Math.min(ROWS_STEP, shown - INITIAL_ROWS);
        if (more <= 0 && less <= 0) return null;
        return (
            <div className="qg-insights-more-row">
                {more > 0 ? (
                    <button
                        type="button"
                        className="qg-insights-more"
                        onClick={() => setShown((s) => Math.min(total, s + ROWS_STEP))}
                        title={`Show ${more} more (${total - shown} hidden)`}
                    >
                        more
                    </button>
                ) : null}
                {less > 0 ? (
                    <button
                        type="button"
                        className="qg-insights-more"
                        onClick={() => setShown((s) => Math.max(INITIAL_ROWS, s - ROWS_STEP))}
                        title={`Show ${less} fewer`}
                    >
                        less
                    </button>
                ) : null}
            </div>
        );
    };
    useEffect(() => {
        cursorsRef.current = {};
    }, [treeDescription]);
    const jumpToNext = useCallback(() => {
        if (issues.length === 0) return;
        const next = (cursor + 1) % issues.length;
        setCursor(next);
        centerOnNode(issues[next]);
    }, [issues, cursor, centerOnNode]);

    // Focus mode dims every non-flagged node so the flagged ones pop on a large plan. The dimming
    // is applied during layout (see tree-layout.ts), driven by this store flag.
    const focus = useGraphRenderingStore((s) => s.focusIssues);
    const setFocusIssues = useGraphRenderingStore((s) => s.setFocusIssues);
    const toggleFocus = useCallback(() => setFocusIssues(!focus), [focus, setFocusIssues]);

    // The rules footer documents what each highlight means; it starts collapsed to keep the panel compact.
    const [rulesOpen, setRulesOpen] = useState(false);

    // The whole tools panel can be minimized to a compact header bar, to get it out of the way on
    // small viewports or when the user just wants to see the graph. Starts expanded.
    const [minimized, setMinimized] = useState(false);

    // Single header line: the actionable findings plus the total scan volume. Which categories are
    // "actionable" (counted here) and how they read in prose is loader policy — the summary is built by
    // walking the loader's rules and taking each that declares `summary` nouns, in the loader's order.
    // A category without `summary` nouns (e.g. "index used", which is informational) is deliberately kept
    // out of the header even though it still shows in the legend and node colors.
    const summaryParts: string[] = [];
    let totalIssues = 0;
    for (const rule of insights?.rules ?? []) {
        if (!rule.summary) continue;
        const count = counts[rule.key] ?? 0;
        if (count === 0) continue;
        totalIssues += count;
        summaryParts.push(`${count} ${count > 1 ? rule.summary.plural : rule.summary.singular}`);
    }
    if (totalProcessed > 0) summaryParts.push(`${formatMetric(totalProcessed)} rows processed`);
    // A hybrid/vector search node is a notable plan characteristic (not an issue), so it is mentioned
    // in the summary but does not flip the verdict to "warn".
    if (searchNodes.length) {
        // Hybrid and pure-vector searches can coexist in one plan; label each group by its own count
        // rather than calling the whole set "hybrid" whenever a single node is (which mislabels the
        // pure-vector ones). Uses "search"/"searches" per group so "1 hybrid search" reads correctly.
        const hybridCount = searchNodes.filter((s) => s.hybrid).length;
        const vectorCount = searchNodes.length - hybridCount;
        const label = (n: number, kind: string) => `${n} ${kind} search${n > 1 ? "es" : ""}`;
        if (hybridCount) summaryParts.push(label(hybridCount, "hybrid"));
        if (vectorCount) summaryParts.push(label(vectorCount, "vector"));
    }
    const summary = summaryParts.length ? summaryParts.join(", ") : "No issues detected";

    return (
        <>
            {/* Summary sits on the top row, centered (same line as the title box). A query failure
                outranks every other finding, so it replaces the summary with a clickable severe banner
                that jumps to the failed operator. */}
            <Panel position="top-center" className="qg-insights qg-insights-summary-panel">
                {errors.length > 0 ? (
                    <button
                        type="button"
                        className="qg-insights-summary qg-insights-verdict-error"
                        onClick={() => centerOnNode(errors[0].id)}
                        title={`${errors[0].label}: ${errors[0].message}\nClick to jump to the failed operator.`}
                    >
                        ⚠ Query failed — {errors[0].message}
                    </button>
                ) : (
                    <span className={`qg-insights-summary ${totalIssues ? "qg-insights-verdict-warn" : "qg-insights-verdict-ok"}`}>
                        {summary}
                    </span>
                )}
            </Panel>
            {/* Legend + navigation stay in the top-right corner. */}
            <Panel
                position="top-right"
                className={`qg-insights qg-insights-tools-panel${minimized ? " qg-insights-minimized" : ""}`}
            >
                <div className="qg-insights-tools-header">
                    <span className="qg-insights-tools-title">Plan insights</span>
                    <button
                        type="button"
                        className="qg-insights-minimize"
                        onClick={() => setMinimized((m) => !m)}
                        aria-expanded={!minimized}
                        title={minimized ? "Expand plan insights" : "Minimize plan insights"}
                    >
                        {minimized ? "+" : "–"}
                    </button>
                </div>
                {minimized ? null : (
                    <>
                        {errors.length > 0 ? (
                            <div className="qg-insights-errors">
                                <div className="qg-insights-errors-title">Query error{errors.length > 1 ? "s" : ""}</div>
                                {errors.map((e) => (
                                    <button
                                        key={e.id}
                                        type="button"
                                        className="qg-insights-error"
                                        onClick={() => centerOnNode(e.id)}
                                        title={`${e.label}: ${e.message}\nClick to jump to the failed operator.`}
                                    >
                                        <span className="qg-insights-error-label">{trimLabel(e.label)}</span>
                                        <span className="qg-insights-error-message">{e.message}</span>
                                    </button>
                                ))}
                            </div>
                        ) : null}
                        {/* The legend lists the loader's legend-level categories that occur in this plan
                            (a zero-count row is just noise). The rows, labels, swatches and order all come
                            from the loader's `insights.rules`, so the rendering stage carries no database
                            vocabulary — it counts by matching each rule's `key` against the baked
                            `insightCategories`. */}
                        <div className="qg-insights-legend">
                            {(insights?.rules ?? [])
                                .filter((r) => r.legend && (counts[r.key] ?? 0) > 0)
                                .map((r) => (
                                    <button
                                        key={r.key}
                                        type="button"
                                        className="qg-insights-legend-item"
                                        onClick={() => drillInto(byCategory[r.key] ?? [], r.key)}
                                        title={`Click to drill into ${r.label.toLowerCase()} nodes`}
                                    >
                                        <span className={`qg-insights-swatch ${r.swatchClass}`} />
                                        {r.label}
                                        <span className="qg-insights-count">({counts[r.key]})</span>
                                    </button>
                                ))}
                        </div>
                        {scans.length > 0 ? (
                            <RankedList
                                title="Top scans by rows processed"
                                hotClass="qg-insights-metric-costly"
                                onSelect={centerOnNode}
                                controls={revealControls(scansShown, setScansShown, scans.length)}
                                rows={offenders.map((o) => ({
                                    id: o.id,
                                    label: o.label,
                                    metric: formatMetric(o.processed),
                                    hot: o.costlyScan,
                                    title:
                                        `Scan of ${o.label}: processed ${formatMetric(o.processed)} rows` +
                                        (typeof o.matching === "number"
                                            ? `, ${formatMetric(o.matching)} matched restrictions`
                                            : "") +
                                        ". Click to jump.",
                                }))}
                            />
                        ) : null}
                        {cpus.length > 0 ? (
                            <RankedList
                                title="Top operators by CPU"
                                hotClass="qg-insights-metric-cpu"
                                onSelect={centerOnNode}
                                controls={revealControls(cpuShown, setCpuShown, cpus.length)}
                                rows={cpuOps.map((c) => {
                                    const share = totalCpu > 0 ? c.cycles / totalCpu : 0;
                                    return {
                                        id: c.id,
                                        label: c.label,
                                        metric: formatMetric(c.cycles),
                                        // The loader's baked runtime-hotspot verdict, so the list agrees
                                        // with the violet node tint.
                                        hot: c.hot,
                                        title:
                                            `${c.label}: used ${formatMetric(c.cycles)} CPU cycles` +
                                            (totalCpu > 0 ? ` — ${Math.round(share * 100)}% of the plan's total runtime` : "") +
                                            ". Click to jump.",
                                    };
                                })}
                            />
                        ) : null}
                        {mems.length > 0 ? (
                            <RankedList
                                title="Top operators by memory"
                                hotClass="qg-insights-metric-mem"
                                onSelect={centerOnNode}
                                controls={revealControls(memShown, setMemShown, mems.length)}
                                rows={memoryOps.map((m) => {
                                    const share = totalMemory > 0 ? m.bytes / totalMemory : 0;
                                    return {
                                        id: m.id,
                                        label: m.label,
                                        metric: formatBytes(m.bytes),
                                        // The loader's baked memory-hotspot verdict, so the list agrees
                                        // with the orange node tint.
                                        hot: m.hot,
                                        title:
                                            `${m.label}: held ${formatBytes(m.bytes)}` +
                                            (totalMemory > 0 ? ` — ${Math.round(share * 100)}% of the plan's peak memory` : "") +
                                            ". Click to jump.",
                                    };
                                })}
                            />
                        ) : null}
                        {scanTypes.length > 0 ? (
                            <div className="qg-insights-list">
                                <div className="qg-insights-list-title">Scan types</div>
                                {scanTypes.map((s) => (
                                    <button
                                        key={s.type}
                                        type="button"
                                        className="qg-insights-list-row"
                                        onClick={() => drillInto(s.ids, `scantype:${s.type}`)}
                                        title={`${s.ids.length} ${s.type} scan${s.ids.length > 1 ? "s" : ""}. Click to jump${s.ids.length > 1 ? " (cycles through them)" : ""}.`}
                                    >
                                        <span className="qg-insights-list-label">{s.type}</span>
                                        <span className="qg-insights-list-metric">{s.ids.length}</span>
                                    </button>
                                ))}
                            </div>
                        ) : null}
                        {searchNodes.length > 0 ? (
                            <div className="qg-insights-list">
                                <div className="qg-insights-list-title qg-insights-search-title">
                                    {searchNodes.some((s) => s.hybrid) ? "Hybrid / vector search" : "Vector search"}
                                </div>
                                {searchNodes.map((s) => (
                                    <button
                                        key={s.id}
                                        type="button"
                                        className="qg-insights-list-row qg-insights-search-item"
                                        onClick={() => centerOnNode(s.id)}
                                        title={
                                            `${s.hybrid ? "Hybrid" : "Vector"} search on ${s.label}` +
                                            (s.detail ? ` (${s.detail})` : "") +
                                            ". Click to jump."
                                        }
                                    >
                                        <span className="qg-insights-search-badge">{s.hybrid ? "hybrid" : "vector"}</span>
                                        <span className="qg-insights-search-label">{trimLabel(s.label)}</span>
                                        {s.detail ? <span className="qg-insights-search-detail">{s.detail}</span> : null}
                                    </button>
                                ))}
                            </div>
                        ) : null}
                        {issues.length > 0 ? (
                            <div className="qg-insights-actions">
                                <button type="button" onClick={jumpToNext}>
                                    Next issue{" "}
                                    {cursor >= 0 ? `(${(cursor % issues.length) + 1}/${issues.length})` : `(${issues.length})`}
                                </button>
                                <button type="button" onClick={toggleFocus} className={focus ? "qg-active" : undefined}>
                                    {focus ? "Show all" : "Focus issues"}
                                </button>
                            </div>
                        ) : null}
                        {/* Footer: what each highlight means, and (for plans that expose adjustable knobs)
                            editable thresholds. The categories, copy, and threshold knobs all come from the
                            loader's `insights` capability — the rendering stage carries no database-specific
                            vocabulary, it just draws the rules and echoes threshold edits back through
                            `setThreshold` (QueryGraph then re-highlights via `insights.rehighlight`). Starts
                            collapsed to keep the panel compact. */}
                        <div className="qg-insights-rules">
                            <button
                                type="button"
                                className="qg-insights-rules-toggle"
                                onClick={() => setRulesOpen((o) => !o)}
                                aria-expanded={rulesOpen}
                            >
                                <span className={`qg-insights-rules-caret${rulesOpen ? " qg-open" : ""}`}>▸</span>
                                How highlighting works
                            </button>
                            {rulesOpen ? (
                                <div className="qg-insights-rules-body">
                                    {(insights?.rules ?? []).map((rule) => {
                                        // The knobs this category exposes, resolved from the threshold list.
                                        const fields = rule.thresholdKeys
                                            .map((k) => thresholdByKey.get(k))
                                            .filter((t): t is InsightsThreshold => t !== undefined);
                                        return (
                                            <div key={rule.label} className="qg-insights-rule">
                                                <div className="qg-insights-rule-head">
                                                    <span className={`qg-insights-swatch ${rule.swatchClass}`} />
                                                    <span className="qg-insights-rule-label">{rule.label}</span>
                                                </div>
                                                <div className="qg-insights-rule-desc">{rule.description}</div>
                                                {fields.length > 0 ? (
                                                    <div className="qg-insights-rule-fields">
                                                        {fields.map((f) => {
                                                            const value = highlightThresholds[f.key] ?? f.value;
                                                            return (
                                                                <label key={f.key} className="qg-insights-rule-field">
                                                                    <span className="qg-insights-rule-field-label">{f.label}</span>
                                                                    <span className="qg-insights-rule-field-input">
                                                                        <input
                                                                            type="text"
                                                                            inputMode="numeric"
                                                                            // A text input (not type=number) so the value
                                                                            // can render with thousands separators; commas
                                                                            // are stripped on parse.
                                                                            value={value.toLocaleString("en-US")}
                                                                            onChange={(e) => {
                                                                                const v = Number(e.target.value.replace(/,/g, ""));
                                                                                // Ignore an empty/invalid field (NaN) so the
                                                                                // plan isn't re-highlighted mid-edit; clamp
                                                                                // to the min.
                                                                                if (Number.isNaN(v)) return;
                                                                                setThreshold(f.key, Math.max(f.min, v));
                                                                            }}
                                                                        />
                                                                        {f.unit ? (
                                                                            <span className="qg-insights-rule-field-unit">
                                                                                {f.unit}
                                                                            </span>
                                                                        ) : null}
                                                                    </span>
                                                                </label>
                                                            );
                                                        })}
                                                    </div>
                                                ) : null}
                                            </div>
                                        );
                                    })}
                                    {(insights?.thresholds.length ?? 0) > 0 ? (
                                        <button type="button" className="qg-insights-rules-reset" onClick={resetThresholds}>
                                            Reset to defaults
                                        </button>
                                    ) : null}
                                </div>
                            ) : null}
                        </div>
                    </>
                )}
            </Panel>
        </>
    );
}
