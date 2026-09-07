import type {TreeNode, TreeDescription, Crosslink, IconName} from "../tree-description";
import {allChildren} from "../tree-description";
import type {Json, JsonObject} from "./loader-utils";
import {forceToString, tryToString, formatMetric, formatBytes, hasOwnProperty, tryGetPropertyPath} from "./loader-utils";
import {createInsightsCapability, staticInsightsCapability} from "./highlight-rules";

const PIPELINE_PALETTE = [
    "#4e79a7", // blue
    "#f28e2b", // orange
    "#59a14f", // green
    "#b6992d", // gold
    "#499894", // teal
    "#e15759", // red
    "#79706e", // gray
    "#d37295", // pink
    "#b07aa1", // purple
    "#9d7660", // brown
    "#a0cbe8", // light blue
    "#ffbe7d", // light orange
    "#8cd17d", // light green
    "#f1ce63", // light gold
    "#86bcb6", // light teal
    "#ff9d9a", // light red
    "#bab0ac", // light gray
    "#fabfd2", // light pink
    "#d4a6c8", // light purple
    "#d7b5a6", // light brown
];

function pipelineColor(index: number): string {
    return PIPELINE_PALETTE[index % PIPELINE_PALETTE.length];
}

interface UnresolvedCrosslink {
    source: TreeNode;
    targetOpId: string;
}

// Only these tags populate scan-only stats (`processed-rows`, `rows-matching-restrictions`) and estimated/matching-rows edges.
const SCAN_OPERATORS = new Set([
    // Newer plans emit a generic `scan` (with `type`, e.g. `data-lake-object`) instead of per-format tags; treat as scan.
    "scan",
    "tablescan",
    "arrowscan",
    "binaryscan",
    "csvscan",
    "cloudtablescan",
    "cursorscan",
    "icebergscan",
    "parquetscan",
    "tdescan",
]);

// Join operators carry a `condition` predicate; surface it inline like filters, not just in the collapsed subtree.
const JOIN_OPERATORS = new Set([
    "join",
    "leftouterjoin",
    "rightouterjoin",
    "fullouterjoin",
    "leftantijoin",
    "rightantijoin",
    "leftsemijoin",
    "rightsemijoin",
    "leftsinglejoin",
    "rightsinglejoin",
    "leftmarkjoin",
    "rightmarkjoin",
]);

// FORMAT JSON rework (W-22563058) renamed runtime block `analyze` -> `statistics` (`tuple-count` -> `output-rows`); try new then legacy.
function getStatistic(rawNode: Json, key: string): Json | undefined {
    return tryGetPropertyPath(rawNode, ["statistics", key]) ?? tryGetPropertyPath(rawNode, ["analyze", key]);
}

// Reads a failed plan's operator error from runtime-statistics: one-line, translated message preferred, SQLSTATE-prefixed.
function getErrorMessage(rawNode: Json): string | undefined {
    const error = getStatistic(rawNode, "error");
    if (typeof error !== "object" || error === null || Array.isArray(error)) {
        // Plain-string error (older shapes) used as-is; anything else (incl. null) has none.
        return typeof error === "string" && error.length > 0 ? error : undefined;
    }
    const messageNode = tryGetPropertyPath(error, ["message"]);
    const message =
        typeof messageNode === "string"
            ? messageNode
            : [tryGetPropertyPath(error, ["message", "translation"]), tryGetPropertyPath(error, ["message", "original"])].find(
                  (m): m is string => typeof m === "string",
              );
    if (message === undefined || message.length === 0) return undefined;
    const code = tryGetPropertyPath(error, ["code"]);
    return typeof code === "string" && code.length > 0 ? `[${code}] ${message}` : message;
}

// Runtime metrics an operator emits into `analyze`/`statistics`, mapped to its surfaced property; only on runtime plans.
const RUNTIME_METRIC_PROPS: {key: string; prop: string; format: (v: number) => string}[] = [
    {key: "execution-time", prop: "execution-time", format: (v) => formatMetric(v)},
    {key: "memory-bytes", prop: "memory-bytes", format: (v) => formatBytes(v)},
    {key: "pipeline", prop: "pipeline", format: (v) => v.toString()},
];

// `statistics` is overloaded: usually the renamed runtime block, but on a scan it's table metadata; distinguish via a runtime key.
const RUNTIME_STATISTIC_KEYS = ["cpu-cycles", "tuple-count", "output-rows", "processed-rows", "running", "pipeline"];
function isRuntimeStatistics(stats: Json | undefined): boolean {
    if (typeof stats !== "object" || stats === null || Array.isArray(stats)) return false;
    return RUNTIME_STATISTIC_KEYS.some((k) => k in stats);
}

// Optimizer estimate `cardinality` -> `estimated-rows` (W-22563058), new first; external plans carry only `statistics.estimated-rows`.
function getEstimatedRows(rawNode: Json): Json | undefined {
    return (
        tryGetPropertyPath(rawNode, ["estimated-rows"]) ??
        tryGetPropertyPath(rawNode, ["statistics", "estimated-rows"]) ??
        tryGetPropertyPath(rawNode, ["cardinality"])
    );
}

// The generic property loop already copied this under `estimated-rows`/`cardinality`; drop both before setting the formatted value.
function setFormattedEstimatedRows(properties: Map<string, string>, estRows: number) {
    properties.delete("estimated-rows");
    properties.delete("cardinality");
    properties.set("estimated-rows", formatMetric(estRows));
}

function getActualRows(rawNode: Json): Json | undefined {
    const outputRows = getStatistic(rawNode, "output-rows");
    return outputRows === undefined ? tryGetPropertyPath(rawNode, ["analyze", "tuple-count"]) : outputRows;
}

// A `udtablefunction` UDF's details live under `args[i].variant.language-specific-metadata.properties.<key>.value`.
function findUdfMetadataProperties(rawNode: Json): JsonObject | undefined {
    const args = tryGetPropertyPath(rawNode, ["args"]);
    if (!Array.isArray(args)) return undefined;
    for (const arg of args) {
        const props = tryGetPropertyPath(arg, ["variant", "language-specific-metadata", "properties"]);
        if (typeof props === "object" && props !== null && !Array.isArray(props)) {
            return props as JsonObject;
        }
    }
    return undefined;
}

// Read a `{classification, value}`-wrapped metadata entry as a plain string.
function getUdfMetadataString(props: JsonObject, key: string): string | undefined {
    const value = tryGetPropertyPath(props, [key, "value"]);
    return typeof value === "string" ? value : undefined;
}

// A search UDF's first `tableref` arg's `table-name` carries `{database, schema, table}`; return the bare table name.
function findUdfTableName(rawNode: Json): string | undefined {
    const args = tryGetPropertyPath(rawNode, ["args"]);
    if (!Array.isArray(args)) return undefined;
    for (const arg of args) {
        const table = tryGetPropertyPath(arg, ["variant", "tableref", "table-name", "table"]);
        if (typeof table === "string") return table;
    }
    return undefined;
}

// Source tables behind a search UDF's index/view come from `language-specific-metadata.leafTables[].tableName.table`.
function findUdfLeafTables(rawNode: Json): string[] {
    const args = tryGetPropertyPath(rawNode, ["args"]);
    if (!Array.isArray(args)) return [];
    const tables = args.flatMap((arg) => {
        const leaves = tryGetPropertyPath(arg, ["variant", "language-specific-metadata", "leafTables"]);
        return Array.isArray(leaves) ? leaves.map((leaf) => tryGetPropertyPath(leaf, ["tableName", "table"])) : [];
    });
    return [...new Set(tables.filter((t): t is string => typeof t === "string"))];
}

// Relevance-score columns (`vector_score__c`/`keyword_score__c`/`hybrid_score__c`) come from `output-columns[].name` or `ius[i]`.
function findUdfScoreColumns(rawNode: Json): string[] {
    const names: string[] = [];
    const seen = new Set<string>();
    const add = (raw: string | undefined) => {
        if (raw === undefined) return;
        const bare = raw.slice(raw.lastIndexOf(".") + 1);
        const m = /^(.+)_score__c$/.exec(bare);
        if (m === null) return;
        const short = m[1];
        if (!seen.has(short)) {
            seen.add(short);
            names.push(short);
        }
    };
    const outputColumns = tryGetPropertyPath(rawNode, ["output-columns"]);
    if (Array.isArray(outputColumns)) {
        for (const col of outputColumns) add(tryToString(tryGetPropertyPath(col, ["name"])));
    }
    // Falls back to `ius` (older plans) only when `output-columns` is empty; names there are truncated, so matching is best-effort.
    if (names.length === 0) {
        const ius = tryGetPropertyPath(rawNode, ["ius"]);
        if (Array.isArray(ius)) {
            for (const entry of ius) add(Array.isArray(entry) ? tryToString(entry[0]) : undefined);
        }
    }
    const rank = (s: string) => (s === "hybrid" ? 0 : s === "vector" ? 1 : s === "keyword" ? 2 : 3);
    return names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

// Reads a field from a metadata entry whose `value` is JSON-encoded; undefined if missing, invalid JSON, or lacking the field.
function getUdfMetadataJsonField(props: JsonObject, key: string, field: string): string | undefined {
    const raw = getUdfMetadataString(props, key);
    if (raw === undefined) return undefined;
    let parsed: Json;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return undefined;
    }
    // Narrows on `typeof === "string"`, not `tryToString`, which turns a missing field into "undefined", falsely flagging a search.
    const value = tryGetPropertyPath(parsed, [field]);
    return typeof value === "string" ? value : undefined;
}

const EXPRESSION_OPERATORS: Record<string, string> = {
    add: "+",
    sub: "-",
    mul: "*",
    div: "/",
    mod: "%",
    and: "AND",
    or: "OR",
};

// A `Double`/`Float` const's `value` is a raw 64-bit IEEE-754 bit pattern; reinterpret via two 32-bit words (no BigInt).
function reinterpretDoubleBits(bits: number): number | undefined {
    if (!Number.isFinite(bits) || bits < 0 || Math.floor(bits) !== bits) {
        return undefined;
    }
    const high = Math.floor(bits / 0x100000000);
    const low = bits - high * 0x100000000;
    if (high > 0xffffffff) return undefined;
    const dv = new DataView(new ArrayBuffer(8));
    dv.setUint32(0, high);
    dv.setUint32(4, low >>> 0);
    const value = dv.getFloat64(0);
    // JSON.parse's precision loss corrupts the lowest ~3 decimal digits; trim to 13 sig figs for display.
    return Number(value.toPrecision(13));
}

// Quotes strings so `x = 'PROMO'` reads unambiguous vs `x = 3`; const types differ: plain value, IEEE-754 bits, or scaled int.
function stringifyConst(expr: JsonObject): string | undefined {
    const value = tryGetPropertyPath(expr, ["value", "value"]);
    const type = tryGetPropertyPath(expr, ["value", "type"]);
    const typeName = Array.isArray(type) ? tryToString(type[0]) : undefined;
    // A null literal carries `null: true` instead of `value`; render `NULL`, or one null constant collapses the whole expression.
    if (tryGetPropertyPath(expr, ["value", "null"]) === true) return "NULL";
    // An `Interval` literal has no scalar `value`, only `months`/`days`/`time` (µs); render non-zero parts, not the subtree.
    if (typeName === "Interval") {
        const months = tryGetPropertyPath(expr, ["value", "months"]);
        const days = tryGetPropertyPath(expr, ["value", "days"]);
        const time = tryGetPropertyPath(expr, ["value", "time"]);
        const parts: string[] = [];
        if (typeof months === "number" && months !== 0) parts.push(`${months} month${Math.abs(months) === 1 ? "" : "s"}`);
        if (typeof days === "number" && days !== 0) parts.push(`${days} day${Math.abs(days) === 1 ? "" : "s"}`);
        if (typeof time === "number" && time !== 0) parts.push(`${time}µs`);
        return `INTERVAL ${parts.length > 0 ? parts.join(" ") : "0"}`;
    }
    if ((typeName === "Double" || typeName === "Float") && typeof value === "number") {
        const asDouble = reinterpretDoubleBits(value);
        if (asDouble !== undefined) return asDouble.toString();
    }
    // `Numeric`/`BigNumeric` are fixed-point: unscaled int / 10^scale; `Numeric` uses `value`, `BigNumeric` splits `low`/`high`.
    if ((typeName === "Numeric" || typeName === "BigNumeric") && Array.isArray(type)) {
        const scale = typeof type[2] === "number" ? type[2] : 0;
        let unscaled: number | undefined;
        if (typeof value === "number") {
            unscaled = value;
        } else {
            const low = tryGetPropertyPath(expr, ["value", "low"]);
            const high = tryGetPropertyPath(expr, ["value", "high"]);
            // high * 2^64 + low: exact when high === 0 (common case), an approximation otherwise.
            if (typeof low === "number" && typeof high === "number") {
                unscaled = high * 4294967296 * 4294967296 + low;
            }
        }
        if (unscaled !== undefined) {
            return (scale > 0 ? unscaled / Math.pow(10, scale) : unscaled).toString();
        }
    }
    // Any other type must carry a plain scalar `value`; without one, bail to the subtree instead of literal string "undefined".
    if (value === undefined) return undefined;
    const str = tryToString(value);
    if (str === undefined) return undefined;
    const isText = typeName === "Varchar" || typeName === "Char" || typeName === "Text";
    return isText ? `'${str}'` : str;
}

// Hyper's "IU" names: scan columns are `scan_<column>`; operator-produced ones are `<op><counter>` (e.g. `union82`).
const IU_ORIGIN_LABELS: Record<string, string> = {
    union: "union",
    groupbykey: "group key",
    map: "computed",
    tableconstruction: "literal rows",
    setresult: "set result",
    window: "window",
    unnest: "unnest",
};
function humanizeIuName(name: string | undefined): string | undefined {
    if (name === undefined || name.length === 0) return name;

    // A qualified reference (`c.relkind`, `orders.o_orderkey`) already carries a real column name.
    if (name.includes(".")) return name;
    if (name.startsWith("scan_") && name.length > "scan_".length) {
        return name.slice("scan_".length);
    }
    const match = /^([A-Za-z_][A-Za-z_]*?)(\d+)$/.exec(name);
    const base = match ? match[1] : name;
    const counter = match ? match[2] : undefined;
    const label = IU_ORIGIN_LABELS[base.toLowerCase()];
    if (label !== undefined) {
        return counter !== undefined ? `⟨${label} #${counter}⟩` : `⟨${label}⟩`;
    }
    // Aggregates (`sum`, `avg`, `count2`) are already readable; return verbatim to match the `output columns` name.
    return name;
}

// Plan-scoped map: Hyper IU name -> real column name, recovered from scan `attributes` and the plan's projected output.
let iuDisplayNames = new Map<string, string>();

// Plan-scoped map: IU -> user-facing alias when the query renamed the column (`AS "Account Name"`); preferred over the base name.
let iuAliases = new Map<string, string>();

// Plan-scoped set of every IU referenced by an `iu-ref` anywhere in the plan; used to decide which columns a preview shows.
let referencedIus = new Set<string>();

// Plan-scoped memo: operator node -> IUs it references in its OWN expressions (not a child's); orders `output columns`.
let directRefsCache = new WeakMap<object, Set<string>>();

// Plan-scoped memo for `computeOutputIus`, keyed by node identity — avoids O(n^2) re-derivation down a deep operator chain.
let outputIuCache = new WeakMap<object, OutputColumn[]>();

// Plan-scoped map: a set-op's input node -> that set op's own output columns; authoritative over `computeOutputIus`'s derivation.
let setOpInputColumns = new WeakMap<object, OutputColumn[]>();

// While a join's `condition` renders, maps an IU to which input it's from (`"L"`/`"R"`/`""`); undefined outside a join render.
let iuSideTag: ((iu: string) => "L" | "R" | "") | undefined;

// Walks the plan once since a node can reference an IU named deeper; `underPassthrough` suppresses refs under `output`/`mapping`.
function collectIuInfo(
    node: Json | undefined,
    names: Map<string, string>,
    refs: Set<string>,
    mappingLinks: {target: string; source: string}[],
    underPassthrough = false,
): void {
    if (Array.isArray(node)) {
        for (const child of node) collectIuInfo(child, names, refs, mappingLinks, underPassthrough);
        return;
    }
    if (typeof node !== "object" || node === null) return;

    // Scan attributes: `iu` (a `[name, type]` pair) -> the source column `name`.
    const attributes = node["attributes"];
    if (Array.isArray(attributes)) {
        for (const attr of attributes) {
            const rawName = iuName(tryGetPropertyPath(attr, ["iu"]));
            const colName = tryGetPropertyPath(attr, ["name"]);
            if (typeof rawName === "string" && typeof colName === "string") {
                names.set(rawName, colName);
            }
        }
    }

    // Projected output columns: `output[i].iu` -> `output-names[i]` (the user-facing result names).
    const output = node["output"];
    const outputNames = node["output-names"] ?? node["outputNames"];
    if (Array.isArray(output) && Array.isArray(outputNames)) {
        for (let i = 0; i < output.length && i < outputNames.length; i++) {
            const rawName = iuName(tryGetPropertyPath(output[i], ["iu"]));
            const name = outputNames[i];
            if (typeof rawName === "string" && typeof name === "string") {
                names.set(rawName, name);
            }
        }
    }

    // `explicit-scan`/`temp` mapping's source may be defined later in this walk, so record it as a link resolved afterward.
    const mapping = node["mapping"];
    if (Array.isArray(mapping)) {
        for (const m of mapping) {
            const targetIu = iuName(tryGetPropertyPath(m, ["target"]));
            const source = tryGetPropertyPath(m, ["source"]);
            linkIfIuRef(targetIu, source, mappingLinks);
        }
    }

    // A `group-by` key's fresh `GroupByKeyN` IU lacks a real name; link it to the source IU named via `expression.value`.
    const keyExprs = node["key-expressions"] ?? node["keyExpressions"];
    if (Array.isArray(keyExprs)) {
        for (const k of keyExprs) {
            const targetIu = iuName(tryGetPropertyPath(k, ["iu"]));
            // Newer plans wrap the key under `expression.value`; legacy plans put it directly under `value` — accept both.
            const source = tryGetPropertyPath(k, ["expression", "value"]) ?? tryGetPropertyPath(k, ["value"]);
            linkIfIuRef(targetIu, source, mappingLinks);
        }
    }

    // An `iu-ref`'s `iu` (bare name or `[name, type]`) is a genuine use unless inside a passthrough construct.
    const kind = tryToString(node["expression"])?.replace(/-/g, "");
    if (kind === "iuref" && !underPassthrough) {
        const raw = iuName(node["iu"]);
        if (raw !== undefined) refs.add(raw);
    }

    for (const key of Object.getOwnPropertyNames(node)) {
        collectIuInfo(node[key], names, refs, mappingLinks, underPassthrough || key === "output" || key === "mapping");
    }
}

// Unlike `collectIuInfo` (walks the whole plan), stops at any nested child operator boundary.
function collectDirectRefs(node: Json | undefined, refs: Set<string>, underPassthrough: boolean, isChild: boolean): void {
    if (Array.isArray(node)) {
        for (const child of node) collectDirectRefs(child, refs, underPassthrough, isChild);
        return;
    }
    if (typeof node !== "object" || node === null) return;
    // Boundary: a nested operator owns its own reference scope — do not descend into it.
    if (isChild && node.hasOwnProperty("operator")) return;
    const kind = tryToString(node["expression"])?.replace(/-/g, "");
    if (kind === "iuref" && !underPassthrough) {
        const raw = iuName(node["iu"]);
        if (raw !== undefined) refs.add(raw);
    }
    for (const key of Object.getOwnPropertyNames(node)) {
        collectDirectRefs(node[key], refs, underPassthrough || key === "output" || key === "mapping", true);
    }
}

function directRefsOf(node: object): Set<string> {
    let refs = directRefsCache.get(node);
    if (refs === undefined) {
        refs = new Set<string>();
        collectDirectRefs(node as Json, refs, false, false);
        directRefsCache.set(node, refs);
    }
    return refs;
}

// Alias flood-fill inputs: an undirected "same logical column" graph plus aliased-output seeds not already in `mappingLinks`.
function collectAliasInfo(
    node: Json | undefined,
    links: {a: string; b: string}[],
    seeds: Map<string, string>,
    computed: Map<string, string[]>,
): void {
    if (Array.isArray(node)) {
        for (const child of node) collectAliasInfo(child, links, seeds, computed);
        return;
    }
    if (typeof node !== "object" || node === null) return;

    // Alias seeds: a projection's `output[i].iu` takes the user-facing `output-names[i]`.
    const output = node["output"];
    const outputNames = node["output-names"] ?? node["outputNames"];
    if (Array.isArray(output) && Array.isArray(outputNames)) {
        for (let i = 0; i < output.length && i < outputNames.length; i++) {
            const iu = iuName(tryGetPropertyPath(output[i], ["iu"]));
            const name = outputNames[i];
            if (iu !== undefined && typeof name === "string" && !seeds.has(iu)) seeds.set(iu, name);
        }
    }

    const ius = node["ius"];
    const values = node["values"];
    if (Array.isArray(ius) && Array.isArray(values)) {
        // Set operation: `ius[i]` is output column i; `values[k][i]` is input branch k's iu-ref for it.
        for (const branch of values) {
            if (!Array.isArray(branch)) continue;
            for (let i = 0; i < branch.length && i < ius.length; i++) {
                const kind = tryToString(tryGetPropertyPath(branch[i], ["expression"]))?.replace(/-/g, "");
                if (kind !== "iuref") continue;
                const outIu = iuName(ius[i]);
                const srcIu = iuName(tryGetPropertyPath(branch[i], ["iu"]));
                if (outIu !== undefined && srcIu !== undefined) links.push({a: outIu, b: srcIu});
            }
        }
    } else if (Array.isArray(values)) {
        // A `map`'s `values[j] = {iu, value}`; link produced IU to passthrough source(s), else stash iu-ref leaves in `computed`.
        for (const entry of values) {
            const targetIu = iuName(tryGetPropertyPath(entry, ["iu"]));
            if (targetIu === undefined) continue;
            const value = tryGetPropertyPath(entry, ["value"]);
            const pass = passthroughSourceIus(value);
            if (pass.length > 0) {
                for (const srcIu of pass) links.push({a: targetIu, b: srcIu});
            } else if (!computed.has(targetIu)) {
                computed.set(targetIu, iuRefLeaves(value));
            }
        }
    }

    for (const key of Object.getOwnPropertyNames(node)) collectAliasInfo(node[key], links, seeds, computed);
}

// Every `iu-ref` leaf IU an expression reads (depth-bounded). Resolves a single-source union branch's name.
function iuRefLeaves(expr: Json | undefined, depth = 0): string[] {
    if (depth > 8 || expr === undefined || expr === null || typeof expr !== "object") return [];
    if (Array.isArray(expr)) {
        return expr.flatMap((child) => iuRefLeaves(child, depth + 1));
    }
    const kind = tryToString(expr["expression"])?.replace(/-/g, "");
    if (kind === "iuref") {
        const iu = iuName(tryGetPropertyPath(expr, ["iu"]));
        return iu === undefined ? [] : [iu];
    }
    return Object.getOwnPropertyNames(expr)
        .filter((key) => key !== "expression" && key !== "type")
        .flatMap((key) => iuRefLeaves(expr[key], depth + 1));
}

// A `map` rename target: set ops insert a `map` that only re-types for branch unification (`setCastN = cast(col)`), same column.
function renameSourceIus(value: Json | undefined): string[] {
    const pass = passthroughSourceIus(value);
    if (pass.length > 0) return pass;
    if (value === undefined) return [];
    const kind = tryToString(tryGetPropertyPath(value, ["expression"]))?.replace(/-/g, "");
    if (kind === "cast") {
        // Only a cast of a SINGLE column preserves identity — check the DIRECT operand, not just one `iu-ref` leaf in the subtree.
        return passthroughSourceIus(tryGetPropertyPath(value, ["value"]));
    }
    return [];
}

// `map` rename links so a `setCastN` inherits its source's real name; unlike the alias flood, contributes ONLY a display name.
function collectMapRenameLinks(node: Json | undefined, out: {target: string; source: string}[]): void {
    if (Array.isArray(node)) {
        for (const child of node) collectMapRenameLinks(child, out);
        return;
    }
    if (node === null || typeof node !== "object") return;
    const values = node["values"];
    if (Array.isArray(values) && !Array.isArray(node["ius"])) {
        for (const entry of values) {
            const target = iuName(tryGetPropertyPath(entry, ["iu"]));
            if (target === undefined) continue;
            const value = tryGetPropertyPath(entry, ["value"]);
            for (const source of renameSourceIus(value)) out.push({target, source});
        }
    }
    for (const key of Object.getOwnPropertyNames(node)) collectMapRenameLinks(node[key], out);
}

// A `map` value passes through: `iu-ref` yields its IU; `coalesce` yields its direct `iu-ref` children's IUs (outer-join merge).
function passthroughSourceIus(value: Json | undefined): string[] {
    if (value === undefined) return [];
    const kind = tryToString(tryGetPropertyPath(value, ["expression"]))?.replace(/-/g, "");
    if (kind === "iuref") {
        const iu = iuName(tryGetPropertyPath(value, ["iu"]));
        return iu === undefined ? [] : [iu];
    }
    if (kind === "coalesce") {
        // Only merges two full-outer-join sides of the SAME column; `COALESCE(a, b)` over different columns must NOT be fused.
        const args = [tryGetPropertyPath(value, ["value"]), tryGetPropertyPath(value, ["arguments"])].find(Array.isArray);
        if (!Array.isArray(args)) return [];
        const ius: string[] = [];
        for (const arg of args) {
            const argKind = tryToString(tryGetPropertyPath(arg, ["expression"]))?.replace(/-/g, "");
            if (argKind !== "iuref") return []; // a computed operand -> not a plain column merge
            const iu = iuName(tryGetPropertyPath(arg, ["iu"]));
            if (iu === undefined) return [];
            ius.push(iu);
        }
        const baseNames = new Set(ius.map((iu) => iuDisplayNames.get(iu)));
        if (baseNames.size !== 1 || baseNames.has(undefined)) return [];
        return ius;
    }
    return [];
}

// Order columns relevant-first (parent-read, used-downstream, rest); full list the UI progressively reveals (QueryNode.tsx).
function orderColumnsRelevantFirst(cols: {name: string; iu: string | undefined}[], parentRefs?: Set<string>): string[] {
    const usedByParent = (c: {iu: string | undefined}) => c.iu !== undefined && parentRefs !== undefined && parentRefs.has(c.iu);
    const usedElsewhere = (c: {iu: string | undefined}) => c.iu !== undefined && referencedIus.has(c.iu);
    return [
        ...cols.filter((c) => usedByParent(c)),
        ...cols.filter((c) => !usedByParent(c) && usedElsewhere(c)),
        ...cols.filter((c) => !usedByParent(c) && !usedElsewhere(c)),
    ].map((c) => c.name);
}

// Columns shown before eliding into `... [remaining]`; the UI reveals this many more per click (QueryNode.tsx).
const COLUMN_PREVIEW_COUNT = 2;

// Static column-preview fallback; must match the UI's initial state (see QueryNode.tsx).
function formatColumnPreview(names: string[]): string | undefined {
    if (names.length === 0) return undefined;
    if (names.length <= COLUMN_PREVIEW_COUNT) return names.join(", ");
    return `${names.slice(0, COLUMN_PREVIEW_COUNT).join(", ")} ... [${names.length - COLUMN_PREVIEW_COUNT}]`;
}

interface OutputColumn {
    name: string;
    iu: string | undefined;
}

function findDuplicateNames(names: string[]): string[] {
    const counts = new Map<string, number>();
    for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
    return [...new Set(names)].filter((n) => (counts.get(n) ?? 0) > 1);
}

function dedupOutputColumns(cols: OutputColumn[]): OutputColumn[] {
    const seen = new Set<string>();
    return cols.filter((c) => c.iu === undefined || (!seen.has(c.iu) && seen.add(c.iu)));
}

function outputColumnName(iu: string): string {
    return iuAliases.get(iu) ?? iuDisplayNames.get(iu) ?? iu;
}

// Pull the IU name out of Hyper's `[name, type]` pair (or a bare name).
function iuName(iuPair: Json | undefined): string | undefined {
    const raw = Array.isArray(iuPair) ? iuPair[0] : iuPair;
    return typeof raw === "string" ? raw : undefined;
}

function linkIfIuRef(
    targetIu: string | undefined,
    source: Json | undefined,
    mappingLinks: {target: string; source: string}[],
): void {
    if (targetIu === undefined || source === undefined) return;
    const sourceKind = tryToString(tryGetPropertyPath(source, ["expression"]))?.replace(/-/g, "");
    if (sourceKind !== "iuref") return;
    const sourceIu = iuName(tryGetPropertyPath(source, ["iu"]));
    if (sourceIu !== undefined) mappingLinks.push({target: targetIu, source: sourceIu});
}

// Row inputs: newer plans nest them in `inputs`; older ones use `input`/`left`/`right` (scalar-subquery fields excluded).
function rowInputs(node: JsonObject): Json[] {
    const rawInputs = node["inputs"];
    return Array.isArray(rawInputs)
        ? (rawInputs as Json[])
        : ([node["input"], node["left"], node["right"]].filter((c) => c !== undefined && c !== null) as Json[]);
}

function pushToList<K, V>(map: Map<K, V[]>, key: K, value: V): void {
    const list = map.get(key) ?? [];
    list.push(value);
    map.set(key, list);
}

// Hyper type tuple `[Name, ...args]`: trailing numbers become length/precision/scale (`Numeric(18, 2)`); string modifiers like `nullable` dropped.
function formatTypeName(type: Json | undefined): string | undefined {
    if (!Array.isArray(type) || type.length === 0) return undefined;
    const name = tryToString(type[0]);
    if (name === undefined) return undefined;
    const params = type.slice(1).filter((t): t is number => typeof t === "number");
    return params.length > 0 ? `${name}(${params.join(", ")})` : name;
}

// Operators without their own column list: reconstruct output schema bottom-up from children's outputs + IUs defined/dropped, deduped. Memoized.
function computeOutputIus(node: Json | undefined, depth = 0): OutputColumn[] {
    if (depth > 40 || typeof node !== "object" || node === null || Array.isArray(node)) return [];
    const cached = outputIuCache.get(node);
    if (cached !== undefined) return cached;
    const result = deriveOutputIus(node, depth);
    outputIuCache.set(node, result);
    return result;
}

function deriveOutputIus(node: JsonObject, depth: number): OutputColumn[] {
    const children = rowInputs(node);
    const childColumns = (idx?: number): OutputColumn[] => {
        const picked = idx === undefined ? children : children[idx] !== undefined ? [children[idx]] : [];
        return dedupOutputColumns(picked.flatMap((c) => computeOutputIus(c, depth + 1)));
    };

    // Concatenated-lowercase tag so kebab (`group-by`) and legacy (`groupby`) spellings hit the same branch.
    const tag = (tryToString(node["operator"]) ?? "").replace(/-/g, "").toLowerCase();

    // Scan family / virtual table: `attributes[].iu` -> the source column `name`.
    const attributes = node["attributes"];
    if (Array.isArray(attributes) && (tag.endsWith("scan") || tag === "virtualtable")) {
        return dedupOutputColumns(
            attributes
                .map((a): OutputColumn | undefined => {
                    const iu = iuName(tryGetPropertyPath(a, ["iu"]));
                    const nm = tryGetPropertyPath(a, ["name"]);
                    if (iu === undefined && typeof nm !== "string") return undefined;
                    // Prefer query alias, then recovered display name — must match the scan annotation below.
                    const display = iu !== undefined ? (iuAliases.get(iu) ?? iuDisplayNames.get(iu)) : undefined;
                    return {name: display ?? (typeof nm === "string" ? nm : iu!), iu};
                })
                .filter((c): c is OutputColumn => c !== undefined),
        );
    }
    // explicit-scan / temp: re-projects a materialized result via `mapping` (source -> renamed target).
    if (tag === "explicitscan" || tag === "temp") {
        const mapping = node["mapping"];
        if (!Array.isArray(mapping)) return childColumns();
        return dedupOutputColumns(
            mapping
                .map((m): OutputColumn | undefined => {
                    const name = stringifyExpression(tryGetPropertyPath(m, ["source"]));
                    const iu = iuName(tryGetPropertyPath(m, ["target"]));
                    if (name === undefined || name.length === 0) return undefined;
                    return {name, iu};
                })
                .filter((c): c is OutputColumn => c !== undefined),
        );
    }
    // Set operations (union-all / except-all / intersect-all) expose their result IUs in `ius`.
    if (Array.isArray(node["ius"])) {
        const ius = node["ius"] as Json[];
        // `values[k]` is branch k's per-position iu-refs, positionally aligned to `ius`.
        const branches = node["values"];
        return dedupOutputColumns(
            ius
                .map((e, i): OutputColumn | undefined => {
                    const iu = iuName(e);
                    if (iu === undefined) return undefined;
                    const known = iuAliases.get(iu) ?? iuDisplayNames.get(iu);
                    if (known !== undefined) return {name: known, iu};
                    // Branches disagree on/lack a source name — annotate the IU with the distinct real source names (`union195 (uniqueid__c / UID__c)`).
                    const sources: string[] = [];
                    if (Array.isArray(branches)) {
                        for (const branch of branches) {
                            const entry = Array.isArray(branch) ? branch[i] : undefined;
                            const srcIu = entry === undefined ? undefined : iuName(tryGetPropertyPath(entry, ["iu"]));
                            const srcName = srcIu !== undefined ? (iuAliases.get(srcIu) ?? iuDisplayNames.get(srcIu)) : undefined;
                            if (srcName !== undefined && !sources.includes(srcName)) sources.push(srcName);
                        }
                    }
                    const name = sources.length > 0 ? `${iu} (${sources.join(" / ")})` : (humanizeIuName(iu) ?? iu);
                    return {name, iu};
                })
                .filter((c): c is OutputColumn => c !== undefined),
        );
    }
    // `tableconstruction` lists its result IUs in `output` (each an `[iu, type]` pair).
    if (tag === "tableconstruction" && Array.isArray(node["output"])) {
        return dedupOutputColumns(
            (node["output"] as Json[])
                .map((e): OutputColumn | undefined => {
                    const iu = iuName(e);
                    return iu === undefined ? undefined : {name: outputColumnName(iu), iu};
                })
                .filter((c): c is OutputColumn => c !== undefined),
        );
    }

    // `map` appends computed columns (`values[].iu`) to child output; name by the computed expression when short, else the raw IU.
    if (tag === "map" && Array.isArray(node["values"])) {
        const computed = (node["values"] as Json[])
            .map((v): OutputColumn | undefined => {
                const iu = iuName(tryGetPropertyPath(v, ["iu"]));
                if (iu === undefined) return undefined;
                const expr = stringifyExpression(tryGetPropertyPath(v, ["value"]));
                const name = expr !== undefined && expr.length > 0 && expr.length <= 30 ? expr : outputColumnName(iu);
                return {name, iu};
            })
            .filter((c): c is OutputColumn => c !== undefined);
        return dedupOutputColumns([...childColumns(), ...computed]);
    }
    // `group-by` drops input columns, emits only grouping keys + aggregates; name a key by its expression, aggregates by IU.
    if (tag === "groupby") {
        // Accept both kebab (`key-expressions`) and legacy camelCase (`keyExpressions`) spellings.
        const keyExprs = node["key-expressions"] ?? node["keyExpressions"];
        const keys = (Array.isArray(keyExprs) ? (keyExprs as Json[]) : [])
            .map((k): OutputColumn | undefined => {
                const iu = iuName(tryGetPropertyPath(k, ["iu"]));
                if (iu === undefined) return undefined;
                const expr = stringifyExpression(tryGetPropertyPath(k, ["expression", "value"]));
                const name = expr !== undefined && expr.length > 0 && expr.length <= 30 ? expr : outputColumnName(iu);
                return {name, iu};
            })
            .filter((c): c is OutputColumn => c !== undefined);
        const aggs = (Array.isArray(node["aggregates"]) ? (node["aggregates"] as Json[]) : [])
            .map((a): OutputColumn | undefined => {
                const iu = iuName(tryGetPropertyPath(a, ["iu"]));
                return iu === undefined ? undefined : {name: outputColumnName(iu), iu};
            })
            .filter((c): c is OutputColumn => c !== undefined);
        return dedupOutputColumns([...keys, ...aggs]);
    }
    if (tag === "window" && Array.isArray(node["window-infos"])) {
        const windowIus: OutputColumn[] = [];
        for (const info of node["window-infos"] as Json[]) {
            const directIu = iuName(tryGetPropertyPath(info, ["iu"]));
            if (directIu !== undefined) windowIus.push({name: outputColumnName(directIu), iu: directIu});
            const aggs = tryGetPropertyPath(info, ["aggregation", "aggregates"]);
            if (Array.isArray(aggs)) {
                for (const a of aggs) {
                    const iu = iuName(tryGetPropertyPath(a, ["iu"]));
                    if (iu !== undefined) windowIus.push({name: outputColumnName(iu), iu});
                }
            }
        }
        return dedupOutputColumns([...childColumns(), ...windowIus]);
    }

    // Semi/anti joins keep the probed side; mark joins keep one side + marker IU. `inputs[0]`=left, `inputs[1]`=right.
    if (tag === "leftsemijoin" || tag === "leftantijoin") return childColumns(0);
    if (tag === "rightsemijoin" || tag === "rightantijoin") return childColumns(1);
    if (tag === "leftmarkjoin" || tag === "rightmarkjoin") {
        const base = childColumns(tag === "leftmarkjoin" ? 0 : 1);
        const markerIu = iuName(node["marker"]);
        return markerIu === undefined ? base : dedupOutputColumns([...base, {name: outputColumnName(markerIu), iu: markerIu}]);
    }

    return childColumns();
}

// Push set-op column names onto inputs' aligned columns, top-down (nested first); only fill unnamed IUs, never overwrite.
function propagateSetOpNames(node: Json | undefined, depth = 0): void {
    if (depth > 40 || typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
        for (const child of node) propagateSetOpNames(child, depth + 1);
        return;
    }
    // A set operation is signalled by an `ius` array (the same marker `deriveOutputIus` keys on).
    if (Array.isArray(node["ius"])) {
        const outIus = (node["ius"] as Json[]).map(iuName);
        // The set op's output columns, resolved to display names now (top-down order means already named).
        const outCols: OutputColumn[] = outIus
            .filter((iu): iu is string => iu !== undefined)
            .map((iu) => ({name: outputColumnName(iu), iu}));
        const inputs = rowInputs(node);
        // Each `values[k]` is input k's positional iu-refs for the set op's `ius` (authoritatively aligned).
        const branches = node["values"];
        inputs.forEach((input, k) => {
            // Record to overwrite this input's `output columns` at display time; a first/outermost set op wins.
            if (typeof input !== "object" || input === null || setOpInputColumns.has(input)) return;
            // Prefer the input's own positional source IU over the set op's output IU — real names, not `union2`/`union4`.
            const branch = Array.isArray(branches) ? branches[k] : undefined;
            const cols: OutputColumn[] = outCols.map((c, i) => {
                const entry = Array.isArray(branch) ? branch[i] : undefined;
                if (entry === undefined) return c;
                const kind = tryToString(tryGetPropertyPath(entry, ["expression"]))?.replace(/-/g, "");
                const srcIu = kind === "iuref" ? iuName(tryGetPropertyPath(entry, ["iu"])) : undefined;
                return srcIu !== undefined ? {name: outputColumnName(srcIu), iu: srcIu} : c;
            });
            setOpInputColumns.set(input, cols);
            // Deliberately not pushing set-op names by position — order can misalign `ius`; flood-fill uses `values` links.
        });
    }
    for (const key of Object.getOwnPropertyNames(node)) {
        propagateSetOpNames(node[key], depth + 1);
    }
}

// Renders a Hyper expression as a compact string; returns real `undefined` (never the string) so callers fall back to the subtree.
function stringifyExpression(expr: Json | undefined, depth = 0): string | undefined {
    if (depth > 6) return "…";
    // A missing/null operand returns real `undefined`, not `tryToString`'s string, else it leaks into e.g. `NOT (undefined)`.
    if (expr === undefined || expr === null) {
        return undefined;
    }
    if (typeof expr !== "object" || Array.isArray(expr)) {
        return tryToString(expr);
    }
    // Newer plans kebab-case the tag (`iu-ref` vs `iuref`); `kind` drops hyphens, `kindRaw` keeps the original for the fallback.
    const kindRaw = tryToString(expr["expression"]);
    const kind = kindRaw?.replace(/-/g, "");
    switch (kind) {
        case "iuref": {
            // `iu` is a plain column name or `[name, type]`; a malformed iuref falls back to the subtree, not "undefined".
            const raw = iuName(expr["iu"]);
            if (raw === undefined) return undefined;
            const name = iuAliases.get(raw) ?? iuDisplayNames.get(raw) ?? humanizeIuName(raw);

            // Within a join condition, frame which side the column comes from: ⟨L⟩ prefix / ⟨R⟩ suffix.
            if (iuSideTag === undefined) return name;
            const side = iuSideTag(raw);
            if (side === "L") return `⟨L⟩ ${name}`;
            if (side === "R") return `${name} ⟨R⟩`;
            return name;
        }
        case "const":
            return stringifyConst(expr);
        case "comparison": {
            const mode = tryToString(expr["mode"]) ?? "?";
            // Do NOT reorder operands to force `⟨L⟩ … ⟨R⟩` — optimizer order is meaningful; per-operand tags show each side.
            const left = stringifyExpression(expr["left"], depth + 1);
            const right = stringifyExpression(expr["right"], depth + 1);
            if (left === undefined || right === undefined) return undefined;
            return `${left} ${mode} ${right}`;
        }
        case "between": {
            const args = expr["arguments"];
            if (!Array.isArray(args) || args.length < 3) return undefined;
            const value = stringifyExpression(args[0], depth + 1);
            const lo = stringifyExpression(args[1], depth + 1);
            const hi = stringifyExpression(args[2], depth + 1);
            if (value === undefined || lo === undefined || hi === undefined) return undefined;
            return `${value} BETWEEN ${lo} AND ${hi}`;
        }
        case "like": {
            // `[value, pattern, escape?]`; render `value LIKE pattern`, dropping the escape char.
            const args = expr["arguments"];
            if (!Array.isArray(args) || args.length < 2) return undefined;
            const value = stringifyExpression(args[0], depth + 1);
            const pattern = stringifyExpression(args[1], depth + 1);
            if (value === undefined || pattern === undefined) return undefined;
            return `${value} LIKE ${pattern}`;
        }
        case "not": {
            // Negation carries its operand as `input` or a single-element `arguments`.
            const inner =
                stringifyExpression(expr["input"], depth + 1) ??
                (Array.isArray(expr["arguments"]) ? stringifyExpression(expr["arguments"][0], depth + 1) : undefined);
            return inner === undefined ? undefined : `NOT (${inner})`;
        }
        case "isnull":
        case "isnotnull": {
            const inner =
                stringifyExpression(expr["input"], depth + 1) ??
                (Array.isArray(expr["arguments"]) ? stringifyExpression(expr["arguments"][0], depth + 1) : undefined);
            if (inner === undefined) return undefined;
            return `${inner} ${kind === "isnull" ? "IS NULL" : "IS NOT NULL"}`;
        }
        case "in": {
            const args = expr["arguments"];
            if (!Array.isArray(args) || args.length < 2) return undefined;
            const value = stringifyExpression(args[0], depth + 1);
            const set = args.slice(1).map((a) => stringifyExpression(a, depth + 1));
            if (value === undefined || set.some((s) => s === undefined)) return undefined;
            return `${value} IN (${set.join(", ")})`;
        }
        case "cast": {
            // Casts are noise in a predicate; render the inner value, but increment `depth` for the recursion guard.
            return stringifyExpression(expr["value"], depth + 1);
        }
        case "case": {
            // Searched CASE: `cases:[{case,value},...]` + optional `else`; bails to undefined if a branch can't be stringified.
            const cases = expr["cases"];
            if (!Array.isArray(cases) || cases.length === 0) return undefined;
            const parts: string[] = [];
            for (const c of cases) {
                const cond = c !== null && typeof c === "object" ? c : {};
                const when = stringifyExpression((cond as JsonObject)["case"], depth + 1);
                const then = stringifyExpression((cond as JsonObject)["value"], depth + 1);
                if (when === undefined || then === undefined) return undefined;
                parts.push(`WHEN ${when} THEN ${then}`);
            }
            const elseStr = stringifyExpression(expr["else"], depth + 1);
            return `CASE ${parts.join(" ")}${elseStr !== undefined ? ` ELSE ${elseStr}` : ""} END`;
        }
        case "simplecase": {
            // Simple CASE has two shapes: (A) `{value,cases:[{cases,value}],else}` vs (B) `{input,cases:[{value,result}],else}`.
            const scrutinee = stringifyExpression(expr["input"] ?? expr["value"], depth + 1);
            const cases = expr["cases"];
            if (scrutinee === undefined || !Array.isArray(cases) || cases.length === 0) return undefined;
            const parts: string[] = [];
            for (const c of cases) {
                const branch = (c !== null && typeof c === "object" ? c : {}) as JsonObject;
                const shapeA = Array.isArray(branch["cases"]);
                const matchExprs = shapeA ? (branch["cases"] as Json[]) : [branch["value"]];
                const matches = matchExprs.map((m) => stringifyExpression(m, depth + 1));
                const result = stringifyExpression(shapeA ? branch["value"] : branch["result"], depth + 1);
                if (result === undefined || matches.some((m) => m === undefined)) return undefined;
                parts.push(`WHEN ${matches.join(", ")} THEN ${result}`);
            }
            const elseStr = stringifyExpression(expr["else"], depth + 1);
            return `CASE ${scrutinee} ${parts.join(" ")}${elseStr !== undefined ? ` ELSE ${elseStr}` : ""} END`;
        }
        default:
            break;
    }
    if (kind === undefined) return undefined;
    if (kind in EXPRESSION_OPERATORS) {
        const op = EXPRESSION_OPERATORS[kind];
        const args = expr["arguments"];
        if (Array.isArray(args)) {
            const parts = args.map((a) => stringifyExpression(a, depth + 1));
            if (parts.some((p) => p === undefined)) return undefined;
            return parts.join(` ${op} `);
        }
        const left = stringifyExpression(expr["left"], depth + 1);
        const right = stringifyExpression(expr["right"], depth + 1);
        if (left !== undefined && right !== undefined) return `${left} ${op} ${right}`;
    }
    // Generic fallback: renders unrecognized expr as `kind(args)`; unary uses `input`, binary `left`/`right`, else `arguments`.
    const fnArgs = Array.isArray(expr["arguments"])
        ? expr["arguments"]
        : expr.hasOwnProperty("input")
          ? [expr["input"]]
          : expr.hasOwnProperty("left") && expr.hasOwnProperty("right")
            ? [expr["left"], expr["right"]]
            : undefined;
    if (fnArgs !== undefined) {
        const parts = fnArgs.map((a) => stringifyExpression(a, depth + 1));
        if (!parts.some((p) => p === undefined)) {
            return `${kindRaw}(${parts.join(", ")})`;
        }
    }
    return undefined;
}

function setCardinalityEdge(node: TreeNode, conversionState: ConversionState, estimate: number, actual: number, isScan: boolean) {
    // Width follows actual row count so edges share one scale (`setEdgeWidths` normalizes); an estimate would skew it.
    conversionState.edgeWidths.push({node, width: actual});
    // Label reads actual/estimate (actual first), matching postgres.ts's actual/estimated order.
    node.edgeLabel = formatMetric(actual) + "/" + formatMetric(estimate);
    // Raw estimate/actual; edge highlight class and tooltip are derived from these by `deriveNodeDisplay`.
    node.cardEstimate = estimate;
    node.cardActual = actual;
    node.cardIsScan = isScan;
}

interface ConversionState {
    operatorsById: Map<string, TreeNode>;
    crosslinks: UnresolvedCrosslink[];
    edgeWidths: {node: TreeNode; width: number}[];
    runtimes: {node: TreeNode; time: number}[];
    memories: {node: TreeNode; bytes: number}[];
    // Every scan's processed-rows volume, used to total scan work and shade costly scans proportionally.
    scanProcessed: {node: TreeNode; processed: number}[];
    metadata: Map<string, string>;
}

interface NodeRenderingConfig {
    displayNameKey?: string;
    crosslinkSourceKey?: string;
    icon?: IconName;
}

const nodeRenderingConfig: Record<string, NodeRenderingConfig> = {
    "op:execution-target": {icon: "run-query-symbol"},
    "op:output": {icon: "run-query-symbol"},
    "op:filter": {icon: "filter-symbol"},
    "op:sort": {icon: "sort-symbol"},
    "op:group-by": {icon: "groupby-symbol"},
    "op:join": {displayNameKey: "type", icon: "inner-join-symbol", crosslinkSourceKey: "magic"},
    "op:join:inner": {displayNameKey: "type", icon: "inner-join-symbol", crosslinkSourceKey: "magic"},
    "op:join:left-outer": {displayNameKey: "type", icon: "left-join-symbol", crosslinkSourceKey: "magic"},
    "op:join:right-outer": {displayNameKey: "type", icon: "right-join-symbol", crosslinkSourceKey: "magic"},
    "op:join:full-outer": {displayNameKey: "type", icon: "full-join-symbol", crosslinkSourceKey: "magic"},
    "op:join:left-anti": {displayNameKey: "type", crosslinkSourceKey: "magic"},
    "op:join:right-anti": {displayNameKey: "type", crosslinkSourceKey: "magic"},
    "op:join:left-semi": {displayNameKey: "type", crosslinkSourceKey: "magic"},
    "op:join:right-semi": {displayNameKey: "type", crosslinkSourceKey: "magic"},
    "op:join:left-single": {displayNameKey: "type", crosslinkSourceKey: "magic"},
    "op:join:right-single": {displayNameKey: "type", crosslinkSourceKey: "magic"},
    "op:join:left-mark": {displayNameKey: "type", crosslinkSourceKey: "magic"},
    "op:join:right-mark": {displayNameKey: "type", crosslinkSourceKey: "magic"},
    "op:left-outer-join": {icon: "left-join-symbol", crosslinkSourceKey: "magic"},
    "op:right-outer-join": {icon: "right-join-symbol", crosslinkSourceKey: "magic"},
    "op:full-outer-join": {icon: "full-join-symbol", crosslinkSourceKey: "magic"},
    "op:left-anti-join": {crosslinkSourceKey: "magic"},
    "op:right-anti-join": {crosslinkSourceKey: "magic"},
    "op:left-semi-join": {crosslinkSourceKey: "magic"},
    "op:right-semi-join": {crosslinkSourceKey: "magic"},
    "op:left-single-join": {crosslinkSourceKey: "magic"},
    "op:right-single-join": {crosslinkSourceKey: "magic"},
    "op:left-mark-join": {crosslinkSourceKey: "magic"},
    "op:right-mark-join": {crosslinkSourceKey: "magic"},
    "op:early-probe": {icon: "filter-symbol", crosslinkSourceKey: "builder"},
    "op:scan": {displayNameKey: "type", icon: "table-symbol"},
    "op:scan:virtual-table": {displayNameKey: "type", icon: "virtual-table-symbol"},
    "op:table-scan": {icon: "table-symbol"},
    "op:arrow-scan": {icon: "table-symbol"},
    "op:binary-scan": {icon: "table-symbol"},
    "op:csv-scan": {icon: "table-symbol"},
    "op:cloud-table-scan": {icon: "table-symbol"},
    "op:cursor-scan": {icon: "table-symbol"},
    "op:iceberg-scan": {icon: "table-symbol"},
    "op:parquet-scan": {icon: "table-symbol"},
    "op:tde-scan": {icon: "table-symbol"},
    // Table-valued UDF (e.g. Data Cloud `hybrid_search`); `name` holds the function name.
    "op:udtablefunction": {icon: "virtual-table-symbol", displayNameKey: "name"},
    "op:table-construction": {icon: "const-table-symbol"},
    "op:virtual-table": {icon: "virtual-table-symbol"},
    "op:explicit-scan": {icon: "temp-table-symbol", crosslinkSourceKey: "input"},
    "op:temp": {icon: "temp-table-symbol"},
    "op:iteration-increment": {crosslinkSourceKey: "source"},
    "op:insert": {displayNameKey: "type"},
    "exp:comparison": {displayNameKey: "mode"},
    "exp:iu-ref": {displayNameKey: "iu"},
    "exp:reference": {displayNameKey: "id"},
};

// Legacy tags before the kebab-case transition.
const legacyNodeTags: Record<string, string> = {
    "op:executiontarget": "op:execution-target",
    "op:select": "op:filter",
    "op:groupby": "op:group-by",
    "op:leftouterjoin": "op:left-outer-join",
    "op:rightouterjoin": "op:right-outer-join",
    "op:fullouterjoin": "op:full-outer-join",
    "op:leftantijoin": "op:left-anti-join",
    "op:rightantijoin": "op:right-anti-join",
    "op:leftsemijoin": "op:left-semi-join",
    "op:rightsemijoin": "op:right-semi-join",
    "op:leftsinglejoin": "op:left-single-join",
    "op:rightsinglejoin": "op:right-single-join",
    "op:leftmarkjoin": "op:left-mark-join",
    "op:rightmarkjoin": "op:right-mark-join",
    "op:earlyprobe": "op:early-probe",
    "op:tablescan": "op:table-scan",
    "op:arrowscan": "op:arrow-scan",
    "op:binaryscan": "op:binary-scan",
    "op:csvscan": "op:csv-scan",
    "op:cloudtablescan": "op:cloud-table-scan",
    "op:cursorscan": "op:cursor-scan",
    "op:icebergscan": "op:iceberg-scan",
    "op:parquetscan": "op:parquet-scan",
    "op:tdescan": "op:tde-scan",
    "op:tableconstruction": "op:table-construction",
    "op:virtualtable": "op:virtual-table",
    "op:explicitscan": "op:explicit-scan",
    "op:iterationincrement": "op:iteration-increment",
    "exp:iuref": "exp:iu-ref",
};

function isAlwaysExpanded(node: JsonObject, key: string): boolean {
    if (!node.hasOwnProperty("operator")) return false;
    let unwrapped = node[key];
    while (Array.isArray(unwrapped) && unwrapped.length) {
        unwrapped = unwrapped[0];
    }
    if (typeof unwrapped === "object" && !Array.isArray(unwrapped) && unwrapped !== null) {
        return unwrapped.hasOwnProperty("operator");
    }
    return false;
}

function reorderProperties(properties: Map<string, string>, order: string[]): void {
    const reordered = new Map<string, string>();
    for (const key of order) {
        const value = properties.get(key);
        if (value !== undefined) {
            reordered.set(key, value);
        }
    }
    for (const [key, value] of properties) {
        if (!reordered.has(key)) {
            reordered.set(key, value);
        }
    }
    properties.clear();
    for (const [key, value] of reordered) {
        properties.set(key, value);
    }
}

// `agg.operation.aggregate` is the fn; `agg.source` indexes `aggExprs` (missing ⇒ nullary); shared by group-by/window.
function formatAggregateCalls(aggregates: Json[], aggExprs: Json | undefined, overSuffix = ""): string[] {
    const out: string[] = [];
    for (const agg of aggregates) {
        const fnRaw = tryGetPropertyPath(agg, ["operation", "aggregate"]);
        if (typeof fnRaw !== "string") continue;
        const source = tryGetPropertyPath(agg, ["source"]);
        let arg = "*";
        if (typeof source === "number" && Array.isArray(aggExprs) && source >= 0 && source < aggExprs.length) {
            const argExpr = tryGetPropertyPath(aggExprs[source], ["value"]) ?? aggExprs[source];
            arg = stringifyExpression(argExpr) ?? "…";
        }
        const call = `${fnRaw}(${arg})${overSuffix}`;
        const iu = iuName(tryGetPropertyPath(agg, ["iu"]));
        const alias = iu !== undefined ? outputColumnName(iu) : undefined;
        out.push(alias !== undefined && alias.length > 0 ? `${alias} = ${call}` : call);
    }
    return out;
}

function renderConditionAndConjuncts(rawNode: Json, properties: Map<string, string>): void {
    const conditionStr = stringifyExpression(tryGetPropertyPath(rawNode, ["condition"]));
    if (conditionStr !== undefined && conditionStr.length > 0) {
        properties.set("condition", conditionStr);
    }
    const conditionArgs = tryGetPropertyPath(rawNode, ["condition", "arguments"]);
    const conjunctKind = tryToString(tryGetPropertyPath(rawNode, ["condition", "expression"]));
    if (conjunctKind === "and" && Array.isArray(conditionArgs) && conditionArgs.length > 1) {
        properties.set("predicates", conditionArgs.length.toString());
        conditionArgs.forEach((conjunct, i) => {
            const conjunctStr = stringifyExpression(conjunct);
            if (conjunctStr !== undefined && conjunctStr.length > 0) {
                properties.set(`predicate ${i + 1}`, conjunctStr);
            }
        });
    }
}

function convertHyperNode(
    rawNode: Json,
    parentKey,
    conversionState: ConversionState,
    parentOperator?: object,
): TreeNode | TreeNode[] {
    if (tryToString(rawNode) !== undefined) {
        return {
            name: tryToString(rawNode),
        };
    } else if (typeof rawNode === "object" && !Array.isArray(rawNode) && rawNode !== null) {
        const expandedChildren = [] as TreeNode[];
        const collapsedChildren = [] as TreeNode[];
        const properties = new Map<string, string>();
        // IUs the parent directly consumes, so this node's output columns lead with them.
        const parentRefs = parentOperator !== undefined ? directRefsOf(parentOperator) : undefined;
        // Full relevant-first column lists for truncated previews, carried on the node so the UI can reveal them on click.
        const columnLists = new Map<string, string[]>();
        // Duplicate output-column names (empty if none); recomputed per preview, so a set-op overwrite's last write wins.
        let duplicateColumns: string[] = [];
        // Set a column-preview property and, when truncated, stash the full ordered list for the UI.
        const setColumnPreview = (key: string, cols: OutputColumn[]) => {
            const ordered = orderColumnsRelevantFirst(cols, parentRefs);
            const preview = formatColumnPreview(ordered);
            if (preview === undefined) return;
            properties.set(key, preview);
            if (ordered.length > COLUMN_PREVIEW_COUNT) columnLists.set(key, ordered);
            if (key === "output columns") duplicateColumns = findDuplicateNames(ordered);
        };

        let nodeType: "operator" | "expression" | undefined;
        let nodeTag: string | undefined;
        let renderingConfig: NodeRenderingConfig = {};
        if (rawNode.hasOwnProperty("operator")) {
            const val = tryToString(rawNode["operator"]);
            if (val !== undefined) {
                nodeType = "operator";
                nodeTag = val;
                const configKey = legacyNodeTags[`op:${nodeTag}`] ?? `op:${nodeTag}`;
                const subtype = tryToString(rawNode["type"]);
                if (subtype !== undefined && nodeRenderingConfig[`${configKey}:${subtype}`]) {
                    renderingConfig = nodeRenderingConfig[`${configKey}:${subtype}`];
                } else {
                    renderingConfig = nodeRenderingConfig[configKey] ?? {};
                }
            }
        } else if (rawNode.hasOwnProperty("expression")) {
            const val = tryToString(rawNode["expression"]);
            if (val !== undefined) {
                nodeType = "expression";
                nodeTag = val;
                const configKey = legacyNodeTags[`exp:${nodeTag}`] ?? `exp:${nodeTag}`;
                renderingConfig = nodeRenderingConfig[configKey] ?? {};
            }
        }

        // Always displayed; `debugName` is the pre-kebab-case spelling of `debug-name` — accept both.
        const propertyKeys = ["debug-name", "debugName"];
        for (const key of propertyKeys) {
            if (!rawNode.hasOwnProperty(key)) {
                continue;
            }
            // Table name is a sensitivity-wrapped string `{classification, value}`; surface `.value` as `table-name`.
            if (key === "debug-name" || key === "debugName") {
                const value = tryGetPropertyPath(rawNode, [key, "value"]);
                if (typeof value === "string") {
                    properties.set("table-name", value);
                    continue;
                }
            }
            properties.set(key, forceToString(rawNode[key]));
        }

        // Display order for remaining keys: `fixedChildOrder` keys first (in this order), then the rest alphabetically.
        const fixedChildOrder = ["inputs", "input", "left", "right", "value", "value-for-comparison"];
        const orderedKeys = Object.getOwnPropertyNames(rawNode)
            .filter((k) => {
                // Drop the runtime `statistics`/legacy `analyze` block (already surfaced); a metadata block must still show.
                if ((k === "statistics" || k === "analyze") && isRuntimeStatistics(rawNode[k])) return false;
                // `sqlpos` is a raw source-offset span into the original SQL text — visualizer noise.
                if (k === "sqlpos") return false;

                // `propertyKeys` and `operator`/`expression` (via `nodeType`) were already handled above.
                return k != nodeType && propertyKeys.indexOf(k) === -1;
            })
            .sort((a, b) => {
                const fixed1 = fixedChildOrder.indexOf(a);
                const fixed2 = fixedChildOrder.indexOf(b);
                if (fixed1 != -1 || fixed2 != -1) {
                    return (fixed1 == -1 ? Infinity : fixed1) - (fixed2 == -1 ? Infinity : fixed2);
                }
                return a < b ? -1 : a > b ? 1 : 0;
            });

        // Display remaining properties adaptively: simple expressions become properties, everything else becomes child nodes.
        for (const key of orderedKeys) {
            const str = tryToString(rawNode[key]);
            if (str !== undefined) {
                properties.set(key, str);
                continue;
            }

            // Child's parent operator: this node if an operator, else the enclosing one (drives child column ordering).
            const children = isAlwaysExpanded(rawNode, key) ? expandedChildren : collapsedChildren;
            const childParentOperator = nodeType === "operator" ? rawNode : parentOperator;
            const innerNodes = convertHyperNode(rawNode[key], key, conversionState, childParentOperator);
            if (fixedChildOrder.indexOf(key) != -1) {
                // Flatten the array, in case it's one of the `fixedChildOrder` keys.
                if (Array.isArray(innerNodes)) {
                    Array.prototype.push.apply(children, innerNodes);
                } else {
                    // The `key` itself is not inserted as an intermediate node.
                    if (!innerNodes.name) {
                        innerNodes.name = key;
                    }
                    children.push(innerNodes);
                }
            } else if (Array.isArray(innerNodes)) {
                children.push({name: key, collapsedChildren: innerNodes});
            } else if (!innerNodes.name) {
                innerNodes.name = key;
                children.push(innerNodes);
            } else {
                children.push({name: key, children: [innerNodes]});
            }
        }

        const specificDisplayName = renderingConfig.displayNameKey ? properties.get(renderingConfig.displayNameKey) : undefined;
        const debugNameNode = tryGetPropertyPath(rawNode, ["debug-name", "value"]);
        const debugName = typeof debugNameNode === "string" ? debugNameNode : undefined;
        const displayName = debugName ?? specificDisplayName ?? properties?.get("name") ?? nodeTag ?? "";

        const convertedNode = {
            name: displayName,
            icon: renderingConfig.icon,
            properties,
            children: expandedChildren,
            collapsedChildren,
            expandedByDefault: nodeType != "operator" && expandedChildren.length == 0,
        } as TreeNode;

        // Raising operator carries `error`; the executing one is flagged `running: true` (often different nodes).
        const errorMessage = getErrorMessage(rawNode);
        if (errorMessage !== undefined) {
            properties.set("error", errorMessage);
            convertedNode.iconColor = "red";
            convertedNode.errorMessage = errorMessage;
        }
        const errored = conversionState.metadata.has("Error") && getStatistic(rawNode, "running") === true;
        if (errored) {
            convertedNode.iconColor = "red";
        }

        const execTime = getStatistic(rawNode, "cpu-cycles");
        if (typeof execTime === "number") {
            conversionState.runtimes.push({node: convertedNode, time: execTime});
            // Keep the raw figure on the node for the panel's "Top operators by CPU" list.
            convertedNode.cpuTime = execTime;
            // Surfaces measured CPU cycles on the node so it's visible without expanding the collapsed "statistics" subtree.
            properties.set("cpu-cycles", formatMetric(execTime));
        }

        // Surfaces peak memory like cpu-cycles: record for the hotspot pass, keep raw figure, set readable row. Runtime plans only.
        const memoryBytes = getStatistic(rawNode, "memory-bytes");
        if (typeof memoryBytes === "number") {
            conversionState.memories.push({node: convertedNode, bytes: memoryBytes});
            convertedNode.memoryBytes = memoryBytes;
            properties.set("memory-bytes", formatBytes(memoryBytes));
        }

        // Scan operators emit their own edge below; skip the generic cardinality block here to avoid a double push.
        const isScanOperator = nodeType == "operator" && nodeTag !== undefined && SCAN_OPERATORS.has(nodeTag.replace(/-/g, ""));

        // Renamed in the FORMAT JSON rework: `cardinality`→`estimated-rows`, `analyze.tuple-count`→`statistics.output-rows`.
        const estimatedCardRaw = getEstimatedRows(rawNode);
        if (typeof estimatedCardRaw === "number" && !isScanOperator) {
            const actualCard = getActualRows(rawNode);
            if (typeof actualCard === "number") {
                setCardinalityEdge(convertedNode, conversionState, estimatedCardRaw, actualCard, false);
            } else {
                conversionState.edgeWidths.push({node: convertedNode, width: estimatedCardRaw});
                convertedNode.edgeLabel = formatMetric(estimatedCardRaw);
            }
        }

        // Surfaces key scan stats without expanding "statistics" (`getStatistic` also reads legacy "analyze").
        if (isScanOperator) {
            // Scan source type: the generic `scan` carries it in `type`, older operators in the tag.
            const rawScanType = rawNode["type"];
            const scanTypeField = nodeTag === "scan" ? (typeof rawScanType === "string" ? rawScanType : undefined) : nodeTag;
            if (typeof scanTypeField === "string" && scanTypeField.length > 0) {
                convertedNode.scanType = scanTypeField;
            }
            // `est-rows` is the top-level estimate (`estimated-rows`, formerly `cardinality`), not in statistics.
            const estRows = estimatedCardRaw;
            if (typeof estRows === "number") {
                setFormattedEstimatedRows(properties, estRows);
            }
            // Surfaces measured output, matching the edge's fallback to `output-rows` when there's no `rows-matching-restrictions`.
            const scanOutputRows = getActualRows(rawNode);
            if (typeof scanOutputRows === "number") {
                properties.set("output-rows", formatMetric(scanOutputRows));
            }
            const scanStatMetrics: [string, string][] = [
                ["processed-rows", "processed-rows"],
                ["rows-matching-restrictions", "rows-matching"],
            ];
            for (const [jsonKey, label] of scanStatMetrics) {
                const value = getStatistic(rawNode, jsonKey);
                if (typeof value === "number") {
                    properties.set(label, formatMetric(value));
                }
            }
            // Low selectivity (processed >> matching) is the signal Hyper's index recommender keys off.
            const processedRows = getStatistic(rawNode, "processed-rows");
            const rowsMatching = getStatistic(rawNode, "rows-matching-restrictions");
            if (typeof rowsMatching === "number" && typeof estRows === "number") {
                // `isScan` = true selects the "matched the restrictions" wording; rows-matching is the scan's actual output.
                setCardinalityEdge(convertedNode, conversionState, estRows, rowsMatching, true);
            } else if (typeof estRows === "number") {
                // Legacy `analyze` plan without `rows-matching-restrictions`: use measured output; `isScan` = false.
                const actualCard = getActualRows(rawNode);
                if (typeof actualCard === "number") {
                    setCardinalityEdge(convertedNode, conversionState, estRows, actualCard, false);
                } else {
                    conversionState.edgeWidths.push({node: convertedNode, width: estRows});
                    convertedNode.edgeLabel = formatMetric(estRows);
                }
            }
            // Record raw signals only; verdicts/highlights are baked later by `deriveNodeDisplay`.
            if (typeof processedRows === "number") {
                // Remember the raw scan volume so plan-insights can total it and rank scans in the "top offenders" list.
                convertedNode.scanProcessedRows = processedRows;

                // Collect it for the plan-wide processed-rows total, which shades costly scans.
                conversionState.scanProcessed.push({node: convertedNode, processed: processedRows});
            }
            if (typeof rowsMatching === "number") {
                convertedNode.scanRowsMatching = rowsMatching;
            }
            // 0 processed rows + `early-probes` ⇒ likely probe-skipped; require estRows > 0, else a zero estimate is expected.
            const earlyProbes = tryGetPropertyPath(rawNode, ["early-probes"]);
            const hasEarlyProbe = Array.isArray(earlyProbes) && earlyProbes.length > 0;
            if (processedRows === 0 && hasEarlyProbe && typeof estRows === "number" && estRows > 0) {
                properties.set("processed-rows", `${formatMetric(0)} (likely early probe)`);
            }

            // `index-recommendation-candidate` appears only when flagged; `should-recommend-candidate` is its build verdict.
            const idxRecColumn = tryGetPropertyPath(rawNode, ["index-recommendation-candidate", "column"]);
            if (typeof idxRecColumn === "string") {
                const shouldRecommend = tryGetPropertyPath(rawNode, [
                    "statistics",
                    "index-recommender",
                    "should-recommend-candidate",
                ]);
                const suffix = shouldRecommend === true ? " (recommended)" : shouldRecommend === false ? " (not recommended)" : "";
                properties.set("index-rec", idxRecColumn + suffix);
                // Record membership regardless of which highlight color wins below (a costly scan may also carry a rec).
                convertedNode.hasIndexRec = true;
                // `baseHighlight` is an intermediate; final `highlightNode` is picked by precedence below.
                const verdict =
                    shouldRecommend === true
                        ? " Hyper recommends building it."
                        : shouldRecommend === false
                          ? " Hyper does not recommend building it."
                          : "";
                convertedNode.baseHighlight = "index-rec";
                convertedNode.baseHighlightReason = `Index-recommendation candidate on column "${idxRecColumn}".${verdict}`;
                // Color follows precedence (costly scan outranks the rec, shown via `qg-node-index-rec-border`).
            }

            // `used-index` present only when an index was used; `available-indexes` counts existing ones.
            const usedIndexName = tryGetPropertyPath(rawNode, ["used-index", "name"]);
            const availableIndexes = tryGetPropertyPath(rawNode, ["available-indexes"]);
            if (typeof availableIndexes === "number") {
                // Delete the generic-loop copy and re-set so it appears once as a count, not as an index named "3".
                properties.delete("available-indexes");
                properties.set("available-indexes", formatMetric(availableIndexes));
            }
            if (typeof usedIndexName === "string") {
                const covered = tryGetPropertyPath(rawNode, ["used-index", "covered"]);
                const suffix = covered === true ? " (covered)" : covered === false ? " (seek)" : "";
                properties.set("index-used", usedIndexName + suffix);
                convertedNode.hasIndexUsed = true;
                // Only claim baseHighlight if a higher-precedence base (index rec / costly scan) hasn't already.
                if (convertedNode.baseHighlight === undefined) {
                    const how = covered === true ? "a covering scan" : covered === false ? "an index seek" : "an index";
                    convertedNode.baseHighlight = "index-used";
                    convertedNode.baseHighlightReason = `Used index "${usedIndexName}" (${how}).`;
                }
            } else if (typeof availableIndexes === "number" && availableIndexes > 0) {
                properties.set("index-used", "no");
            }

            // Each `attributes` entry pairs an internal IU with its source column `name`.
            const scanAttributes = rawNode["attributes"];
            if (Array.isArray(scanAttributes)) {
                const cols = scanAttributes
                    .map((attr) => {
                        const name = tryGetPropertyPath(attr, ["name"]);
                        if (typeof name !== "string") return undefined;
                        const iuKey = iuName(tryGetPropertyPath(attr, ["iu"]));
                        // Prefer the recovered display name for one consistent name per IU (incl. set-op-propagated).
                        const display = iuKey !== undefined ? iuDisplayNames.get(iuKey) : undefined;
                        const base = display ?? name;
                        // Annotate `base → alias`; never replace the base name here.
                        const alias = iuKey !== undefined ? iuAliases.get(iuKey) : undefined;
                        return {name: alias !== undefined && alias !== base ? `${base} → ${alias}` : base, iu: iuKey};
                    })
                    .filter((c): c is {name: string; iu: string | undefined} => c !== undefined);
                setColumnPreview("output columns", cols);
            }

            // Iceberg/CDP-v2 lakehouse scans carry `table-metadata` (identifier cols, partitioning, sort order).
            const tableMetadata = rawNode["table-metadata"];
            if (tableMetadata !== null && typeof tableMetadata === "object" && !Array.isArray(tableMetadata)) {
                // Render a column transform: `identity` is bare, anything else wraps it (`bucket[16](Id__c)`).
                const withTransform = (transform: Json | undefined, column: Json | undefined): string | undefined => {
                    if (typeof column !== "string") return undefined;
                    return typeof transform !== "string" || transform === "identity" ? column : `${transform}(${column})`;
                };

                // One `table-metadata` property of `label: value` lines; the QueryNode renderer splits on newlines.
                const metaLines: string[] = [];

                const identifierFields = tableMetadata["identifier-fields"];
                if (Array.isArray(identifierFields) && identifierFields.length > 0) {
                    const cols = identifierFields
                        .map((f) => tryGetPropertyPath(f, ["column"]))
                        .filter((c): c is string => typeof c === "string");
                    if (cols.length > 0) {
                        metaLines.push(`identifier: ${cols.join(", ")}`);
                    }
                }

                const partitionTransforms = tableMetadata["partition-transforms"];
                if (Array.isArray(partitionTransforms) && partitionTransforms.length > 0) {
                    const parts = partitionTransforms
                        .map((p) =>
                            withTransform(tryGetPropertyPath(p, ["transform"]), tryGetPropertyPath(p, ["source", "column"])),
                        )
                        .filter((p): p is string => p !== undefined);
                    if (parts.length > 0) {
                        metaLines.push(`partitioned-by: ${parts.join(", ")}`);
                    }
                }

                // Sort order shown verbatim as the plan spells direction/null-order, not reformatted.
                const sortKeys = tryGetPropertyPath(tableMetadata, ["sort-order", "sort-keys"]);
                if (Array.isArray(sortKeys) && sortKeys.length > 0) {
                    const keys = sortKeys
                        .map((k) => {
                            const col = withTransform(
                                tryGetPropertyPath(k, ["transform"]),
                                tryGetPropertyPath(k, ["source", "column"]),
                            );
                            if (col === undefined) return undefined;
                            const dir = tryGetPropertyPath(k, ["direction"]);
                            const nulls = tryGetPropertyPath(k, ["null-order"]);
                            return [col, dir, nulls].filter((x): x is string => typeof x === "string").join(" ");
                        })
                        .filter((k): k is string => k !== undefined);
                    if (keys.length > 0) {
                        metaLines.push(`sort-order: ${keys.join(", ")}`);
                    }
                }

                if (metaLines.length > 0) {
                    properties.set("table-metadata", metaLines.join("\n"));
                }
            }

            reorderProperties(properties, [
                "table-name",
                "output columns",
                "index-rec",
                "estimated-rows",
                "processed-rows",
                "rows-matching",
                "output-rows",
                "available-indexes",
                "index-used",
                "table-metadata",
            ]);
        } else if (nodeType == "operator") {
            // Non-scan operators surface actual output alongside estimate (`rows-matching` excluded); reuses `estimatedCardRaw`.
            const estRows = estimatedCardRaw;
            if (typeof estRows === "number") {
                setFormattedEstimatedRows(properties, estRows);
            }
            // `getActualRows` so old ANALYZE'd plans fall back to `analyze.tuple-count`, matching the edge.
            const outputRows = getActualRows(rawNode);
            if (typeof outputRows === "number") {
                properties.set("output-rows", formatMetric(outputRows));
            }

            // Set when an operator block has its own lead, so the `output columns` fallback appends instead of fronting.
            let hasSemanticLead = false;

            const sortedIndexedKeys = (prefix: string) =>
                [...properties.keys()]
                    .filter((k) => new RegExp(`^${prefix} \\d+$`).test(k))
                    .sort((a, b) => Number(a.slice(prefix.length + 1)) - Number(b.slice(prefix.length + 1)));

            // Hyper names this operator `select` (legacy) or `filter` (newer); same shape, handled together.
            if (nodeTag === "select" || nodeTag === "filter") {
                renderConditionAndConjuncts(rawNode, properties);
                // Selectivity = output/input rows (actuals, else "(est)"); child is `input` (legacy) or `inputs[0]` (newer).
                const inputs = rawNode["inputs"];
                const input = rawNode["input"] ?? (Array.isArray(inputs) ? inputs[0] : null);
                const inputActual = getActualRows(input);
                const inputEst = getEstimatedRows(input);
                let inputRows: number | undefined;
                let filterOut: number | undefined;
                let estimated = false;
                if (typeof inputActual === "number" && typeof outputRows === "number") {
                    inputRows = inputActual;
                    filterOut = outputRows;
                } else if (typeof inputEst === "number" && typeof estRows === "number") {
                    inputRows = inputEst;
                    filterOut = estRows;
                    estimated = true;
                }
                if (typeof inputRows === "number" && typeof filterOut === "number" && inputRows > 0) {
                    const pct = (filterOut / inputRows) * 100;
                    const pctStr = pct < 10 ? pct.toFixed(1) : pct.toFixed(0);
                    properties.set(
                        "selectivity",
                        `${pctStr}% pass (${formatMetric(filterOut)} of ${formatMetric(inputRows)})${estimated ? " (est)" : ""}`,
                    );
                }

                reorderProperties(properties, [
                    "condition",
                    "predicates",
                    ...sortedIndexedKeys("predicate"),
                    "estimated-rows",
                    "output-rows",
                    "selectivity",
                ]);
                hasSemanticLead = true;
            }

            // `JOIN_OPERATORS` holds concatenated spellings; strip hyphens to match kebab-case.
            if (nodeTag !== undefined && JOIN_OPERATORS.has(nodeTag.replace(/-/g, ""))) {
                // Tags each predicate column by join side (left/right) via the two inputs' IUs; sets a module-level hook, cleared after rendering.
                const rawInputs = rawNode["inputs"];
                const leftChild = Array.isArray(rawInputs) ? rawInputs[0] : (rawNode["left"] ?? rawNode["input"]);
                const rightChild = Array.isArray(rawInputs) ? rawInputs[1] : rawNode["right"];
                const iusOf = (child: Json | undefined) =>
                    new Set(
                        computeOutputIus(child)
                            .map((c) => c.iu)
                            .filter((iu): iu is string => iu !== undefined),
                    );
                const leftIus = iusOf(leftChild);
                const rightIus = iusOf(rightChild);
                iuSideTag = (iu) => (leftIus.has(iu) ? "L" : rightIus.has(iu) ? "R" : "");

                renderConditionAndConjuncts(rawNode, properties);
                // Clear the side-tag hook so no later predicate render (a filter, another node) is tagged.
                iuSideTag = undefined;

                reorderProperties(properties, [
                    "condition",
                    "predicates",
                    ...sortedIndexedKeys("predicate"),
                    "method",
                    "estimated-rows",
                    "output-rows",
                ]);
                hasSemanticLead = true;
            }

            if (nodeTag === "group-by" || nodeTag === "groupby") {
                // Surface what the group-by does: which columns it groups on ("group by") and what it aggregates.
                // Each key wraps its expression under `expression.value` (newer) or `value` directly.
                const keyExprs = rawNode["key-expressions"] ?? rawNode["keyExpressions"];
                const keyStrs: string[] = [];
                if (Array.isArray(keyExprs)) {
                    for (const entry of keyExprs) {
                        const keyExpr = tryGetPropertyPath(entry, ["expression", "value"]) ?? tryGetPropertyPath(entry, ["value"]);
                        const s = stringifyExpression(keyExpr);
                        if (s !== undefined && s.length > 0) keyStrs.push(s);
                    }
                }
                if (keyStrs.length > 0) {
                    properties.set("group by", keyStrs.join(", "));
                } else if (Array.isArray(keyExprs) && keyExprs.length > 0) {
                    // Keys present but none rendered: don't mislabel as a keyless aggregate — point at the subtree.
                    properties.set("group by", `${keyExprs.length} key expression${keyExprs.length > 1 ? "s" : ""} (see subtree)`);
                } else {
                    properties.set("group by", "(global aggregate — no keys)");
                }

                // Multiple grouping sets => ROLLUP/CUBE/GROUPING SETS: report the count.
                const groupingSets = rawNode["grouping-sets"] ?? rawNode["groupingSets"];
                if (Array.isArray(groupingSets) && groupingSets.length > 1) {
                    properties.set("grouping sets", groupingSets.length.toString());
                }

                // Rendered as `alias = fn(arg)` via `formatAggregateCalls`; `window` renders the same with an `OVER (...)` suffix.
                const aggregates = rawNode["aggregates"];
                const aggExprs = rawNode["agg-expressions"] ?? rawNode["aggExpressions"];
                const aggStrs = Array.isArray(aggregates) ? formatAggregateCalls(aggregates, aggExprs) : [];
                if (aggStrs.length > 0) {
                    properties.set("aggregates", aggStrs.join(", "));
                }

                reorderProperties(properties, ["group by", "grouping sets", "aggregates", "estimated-rows", "output-rows"]);
                hasSemanticLead = true;
            }

            // Each `criterion` entry carries its key expression under `value`.
            if (nodeTag === "sort") {
                const criterion = rawNode["criterion"];
                const keyStrs: string[] = [];
                if (Array.isArray(criterion)) {
                    for (const c of criterion) {
                        const keyStr = stringifyExpression(tryGetPropertyPath(c, ["value"]));
                        if (keyStr === undefined || keyStr.length === 0) continue;
                        const descending = tryGetPropertyPath(c, ["descending"]) === true;
                        // `null-first` (kebab) or legacy `nullFirst`; annotate only when present (real boolean).
                        const nullFirst = tryGetPropertyPath(c, ["null-first"]) ?? tryGetPropertyPath(c, ["nullFirst"]);
                        const dir = descending ? "desc" : "asc";
                        const nulls = nullFirst === true ? " nulls-first" : nullFirst === false ? " nulls-last" : "";
                        keyStrs.push(`${keyStr} ${dir}${nulls}`);
                    }
                }
                if (keyStrs.length > 0) {
                    properties.set("sort by", keyStrs.join(", "));
                } else if ((!Array.isArray(criterion) || criterion.length === 0) && rawNode["limit"] !== undefined) {
                    // Empty `criterion` + a `limit` is how Hyper encodes a bare LIMIT (no ORDER BY); relabel "sort" -> "limit" and swap the icon.
                    convertedNode.name = "limit";
                    convertedNode.icon = "limit-symbol";
                }
                reorderProperties(properties, ["sort by", "limit", "estimated-rows", "output-rows"]);
                hasSemanticLead = true;
            }

            // Each `map` `values` entry carries the output IU under `iu` and the expression under `value`.
            if (nodeTag === "map") {
                const values = rawNode["values"];
                const colStrs: string[] = [];
                if (Array.isArray(values)) {
                    for (const v of values) {
                        const rawName = iuName(tryGetPropertyPath(v, ["iu"]));
                        // Prefer recovered alias, then base name, so `column N` matches `output columns`; else humanize the IU.
                        const name =
                            typeof rawName === "string"
                                ? (iuAliases.get(rawName) ?? iuDisplayNames.get(rawName) ?? humanizeIuName(rawName))
                                : undefined;
                        const valueExpr = tryGetPropertyPath(v, ["value"]);
                        const exprStr = stringifyExpression(valueExpr);
                        if (name === undefined || exprStr === undefined || exprStr.length === 0) continue;
                        if (name === exprStr) {
                            // Pure rename/cast collapses to the column name; tag transparent cast/coalesce (`col (cast)`).
                            const opKind =
                                valueExpr === undefined
                                    ? undefined
                                    : tryToString(tryGetPropertyPath(valueExpr, ["expression"]))?.replace(/-/g, "");
                            let marker = "";
                            if (opKind === "cast") {
                                const castType =
                                    valueExpr === undefined ? undefined : formatTypeName(tryGetPropertyPath(valueExpr, ["type"]));
                                marker = castType !== undefined ? ` (cast as ${castType})` : " (cast)";
                            } else if (opKind === "coalesce") {
                                marker = " (coalesce)";
                            }
                            colStrs.push(name + marker);
                        } else {
                            colStrs.push(`${name} = ${exprStr}`);
                        }
                    }
                }
                if (colStrs.length > 0) {
                    properties.set("computes", colStrs.length.toString());
                    colStrs.forEach((s, i) => properties.set(`column ${i + 1}`, s));
                }
                reorderProperties(properties, ["computes", ...sortedIndexedKeys("column"), "estimated-rows", "output-rows"]);
                hasSemanticLead = true;
            }

            // Each `window-infos` entry is a window aggregate or ranking/value function, surfaced as `alias = fn(arg) OVER (...)`.
            if (nodeTag === "window") {
                const windowInfos = rawNode["window-infos"] ?? rawNode["windowInfos"];
                // Frame bound: unbounded / current-row / an N-row offset (sign selects preceding vs following), matching SQL frame syntax.
                const frameBound = (info: Json, modeKey: string, expKey: string): string | undefined => {
                    const mode = tryGetPropertyPath(info, [modeKey]);
                    if (mode === "unbounded-preceding" || mode === "unboundedPreceding") return "unbounded preceding";
                    if (mode === "unbounded-following" || mode === "unboundedFollowing") return "unbounded following";
                    if (mode === "current-row" || mode === "currentRow") return "current row";
                    if (mode === "value") {
                        const v = tryGetPropertyPath(info, [expKey, "value", "value"]);
                        if (typeof v === "number") return v === 0 ? "current row" : v < 0 ? `${-v} preceding` : `${v} following`;
                    }
                    return undefined;
                };
                const overClause = (info: Json): string => {
                    const parts: string[] = [];
                    const partitionBy = tryGetPropertyPath(info, ["partition-by"]) ?? tryGetPropertyPath(info, ["partitionBy"]);
                    if (Array.isArray(partitionBy) && partitionBy.length > 0) {
                        const cols = partitionBy
                            .map((p) => stringifyExpression(p))
                            .filter((s): s is string => s !== undefined && s.length > 0);
                        if (cols.length > 0) parts.push(`partition by ${cols.join(", ")}`);
                    }
                    const orderBy = tryGetPropertyPath(info, ["frame-order-by"]) ?? tryGetPropertyPath(info, ["frameOrderBy"]);
                    if (Array.isArray(orderBy) && orderBy.length > 0) {
                        const keys = orderBy
                            .map((c) => {
                                const keyStr = stringifyExpression(tryGetPropertyPath(c, ["value"]));
                                if (keyStr === undefined || keyStr.length === 0) return undefined;
                                const descending = tryGetPropertyPath(c, ["descending"]) === true;
                                return `${keyStr} ${descending ? "desc" : "asc"}`;
                            })
                            .filter((s): s is string => s !== undefined);
                        if (keys.length > 0) parts.push(`order by ${keys.join(", ")}`);
                    }
                    // Only report a frame when both bounds resolve; `exclude: no_others` is the default, so it's intentionally not shown.
                    const mode =
                        tryGetPropertyPath(info, ["rowsmode"]) === true
                            ? "rows"
                            : tryGetPropertyPath(info, ["rangemode"]) === true
                              ? "range"
                              : undefined;
                    if (mode !== undefined) {
                        const start = frameBound(info, "start-mode", "start-exp");
                        const end = frameBound(info, "end-mode", "end-exp");
                        if (start !== undefined && end !== undefined) parts.push(`${mode} between ${start} and ${end}`);
                    }
                    return ` OVER (${parts.join(" ")})`;
                };
                const fnStrs: string[] = [];
                if (Array.isArray(windowInfos)) {
                    for (const info of windowInfos) {
                        const over = overClause(info);
                        const operation = tryGetPropertyPath(info, ["operation"]);
                        if (operation === "aggregate") {
                            // A window aggregate encodes aggregates like a `group-by`, under nested `aggregation`, sharing this `OVER (…)`.
                            const aggregation = tryGetPropertyPath(info, ["aggregation"]);
                            const aggregates =
                                aggregation === undefined ? undefined : tryGetPropertyPath(aggregation, ["aggregates"]);
                            const aggExprs =
                                aggregation === undefined
                                    ? undefined
                                    : (tryGetPropertyPath(aggregation, ["agg-expressions"]) ??
                                      tryGetPropertyPath(aggregation, ["aggExpressions"]));
                            if (Array.isArray(aggregates)) {
                                fnStrs.push(...formatAggregateCalls(aggregates, aggExprs, over));
                            }
                        } else if (typeof operation === "string") {
                            // Ranking/value fns (row_number, rank, lead, lag): `operation` is the fn name, `iu` its result column.
                            const iu = iuName(tryGetPropertyPath(info, ["iu"]));
                            const alias = iu !== undefined ? outputColumnName(iu) : undefined;
                            const call = `${operation}()${over}`;
                            fnStrs.push(alias !== undefined && alias.length > 0 ? `${alias} = ${call}` : call);
                        }
                    }
                }
                if (fnStrs.length > 0) {
                    properties.set("window functions", fnStrs.length.toString());
                    fnStrs.forEach((s, i) => properties.set(`function ${i + 1}`, s));
                }
                reorderProperties(properties, [
                    "window functions",
                    ...sortedIndexedKeys("function"),
                    "estimated-rows",
                    "output-rows",
                ]);
                hasSemanticLead = true;
            }

            // `explicitscan`/`temp` re-reads a shared temp result, re-projecting columns via `mapping` (`source` -> renamed `target` IU).
            if (nodeTag !== undefined && (nodeTag.replace(/-/g, "") === "explicitscan" || nodeTag === "temp")) {
                const mapping = rawNode["mapping"];
                if (Array.isArray(mapping)) {
                    const cols = mapping
                        .map((m) => {
                            // `name` = source column's display name (via `iuDisplayNames`); `iu` = renamed target IU downstream operators reference.
                            const name = stringifyExpression(tryGetPropertyPath(m, ["source"]));
                            if (name === undefined || name.length === 0) return undefined;
                            return {name, iu: iuName(tryGetPropertyPath(m, ["target"]))};
                        })
                        .filter((c): c is {name: string; iu: string | undefined} => c !== undefined);
                    setColumnPreview("output columns", cols);
                }
                reorderProperties(properties, ["output columns", "estimated-rows", "output-rows"]);
            }

            // `execution-target` (plan root): final output columns; accept kebab and legacy concatenated spellings.
            if (nodeTag === "execution-target" || nodeTag === "executiontarget") {
                const outputNames = rawNode["output-names"] ?? rawNode["outputNames"];
                if (Array.isArray(outputNames)) {
                    // Pair each result name with its IU from the parallel `output` array for relevant-first preview ordering.
                    const output = rawNode["output"];
                    const cols = outputNames
                        .map((name, i): OutputColumn | undefined => {
                            if (typeof name !== "string") return undefined;
                            const iu = Array.isArray(output) ? iuName(tryGetPropertyPath(output[i], ["iu"])) : undefined;
                            return {name, iu};
                        })
                        .filter((c): c is OutputColumn => c !== undefined);
                    setColumnPreview("output columns", cols);
                }
                reorderProperties(properties, ["output columns", "estimated-rows", "output-rows"]);
            }

            // `udtablefunction` (e.g. `hybrid_search`) buries index/vector-DB/embedding metadata in the UDF arg; surfaced as properties below.
            if (nodeTag === "udtablefunction") {
                // Require real strings: `tryToString` yields the literal "undefined" for a missing field, showing `function: undefined`.
                const fnName = rawNode["name"];
                if (typeof fnName === "string") {
                    properties.set("function", fnName);
                }
                const volatility = rawNode["volatility"];
                if (typeof volatility === "string") {
                    properties.set("volatility", volatility);
                }
                // The view/model the search targets (UDF's `tableref` argument), e.g. `..._index__dlm`.
                const udfTableName = findUdfTableName(rawNode);
                if (udfTableName !== undefined) {
                    properties.set("table-name", udfTableName);
                }
                // Physical source table(s) behind that view (the `..._chunk__dll` data-lake table); shown only when distinct from `table-name`.
                const leafTables = findUdfLeafTables(rawNode).filter((t) => t !== udfTableName);
                if (leafTables.length > 0) {
                    properties.set("source-table", leafTables.join(", "));
                }

                // Relevance-score columns the search projects; keyword + vector score both present is the authoritative "hybrid search" signal.
                const scoreColumns = findUdfScoreColumns(rawNode);
                if (scoreColumns.length > 0) {
                    properties.set("scores", scoreColumns.join(", "));
                }
                const scoresHybrid = scoreColumns.includes("keyword") && scoreColumns.includes("vector");

                // Declared here so the runtime-telemetry block below can read corpus size even if metadata parsing fails.
                let totalRecords: string | undefined;
                const meta = findUdfMetadataProperties(rawNode);
                if (meta !== undefined) {
                    // Human-readable index name; total-records is the corpus size (context for row estimates).
                    const developerName = getUdfMetadataString(meta, "developer-name");
                    if (developerName !== undefined) {
                        properties.set("index", developerName);
                    }
                    totalRecords = getUdfMetadataString(meta, "total-records");
                    if (totalRecords !== undefined) {
                        const asNum = Number(totalRecords);
                        properties.set("total-records", Number.isFinite(asNum) ? formatMetric(asNum) : totalRecords);
                    }
                    const vectorDb = getUdfMetadataJsonField(meta, "vectorDbConnectionDetails", "vectorDBName");
                    if (vectorDb !== undefined) {
                        properties.set("vector-db", vectorDb);
                    }
                    const indexType = getUdfMetadataJsonField(meta, "vectorAccessProperties", "indexType");
                    if (indexType !== undefined) {
                        properties.set("vector-index", indexType);
                    }
                    const metricType = getUdfMetadataJsonField(meta, "vectorAccessProperties", "metricType");
                    if (metricType !== undefined) {
                        properties.set("similarity-metric", metricType);
                    }
                    const embeddingModel = getUdfMetadataJsonField(meta, "embeddingModelDetails", "model");
                    if (embeddingModel !== undefined) {
                        properties.set("embedding-model", embeddingModel);
                    }
                    const embeddingDim = getUdfMetadataJsonField(meta, "embeddingModelDetails", "dimension");
                    if (embeddingDim !== undefined) {
                        properties.set("embedding-dim", embeddingDim);
                    }
                    // A keyword-index entry means a lexical (BM25-style) leg runs alongside the vector one — the "hybrid" signal.
                    const keywordIndex = getUdfMetadataString(meta, "keywordIndexConnectionDetails");
                    if (keywordIndex !== undefined) {
                        properties.set("keyword-search", "yes");
                    }

                    // Only mark vector/hybrid search when a vector DB or embedding model is present.
                    if (vectorDb !== undefined || embeddingModel !== undefined) {
                        convertedNode.vectorSearch = {
                            function: properties.get("function"),
                            index: developerName,
                            vectorDb,
                            embeddingModel,
                            // Prefer authoritative score-column evidence; fall back to keyword-index metadata.
                            hybrid: scoresHybrid || keywordIndex !== undefined,
                        };
                    }
                }

                // Runtime telemetry lives on the `analyze`/`statistics` block, not the UDF arg metadata parsed above.

                // No processed/matching ratio here — `output-rows` IS the matched count; `total-records` is context, not a denominator.
                const searchOutputRows = getActualRows(rawNode);
                if (typeof searchOutputRows === "number") {
                    const totalRecordsNum = totalRecords !== undefined ? Number(totalRecords) : NaN;
                    const corpus = Number.isFinite(totalRecordsNum) ? ` (index holds ${formatMetric(totalRecordsNum)})` : "";
                    properties.set("matched-records", `${formatMetric(searchOutputRows)} matched${corpus}`);
                }

                // Other runtime telemetry; `cpu-cycles` is already surfaced earlier for every operator.
                for (const {key, prop, format} of RUNTIME_METRIC_PROPS) {
                    const value = getStatistic(rawNode, key);
                    if (typeof value === "number") {
                        properties.set(prop, format(value));
                    }
                }

                // Drop low-signal raw properties: internal catalog index and source-text span.
                properties.delete("function-id");
                properties.delete("sqlpos");

                reorderProperties(properties, [
                    "function",
                    "table-name",
                    "source-table",
                    "index",
                    "total-records",
                    "estimated-rows",
                    "output-rows",
                    "matched-records",
                    "vector-db",
                    "vector-index",
                    "similarity-metric",
                    "embedding-model",
                    "embedding-dim",
                    "keyword-search",
                    "scores",
                    "volatility",
                    "cpu-cycles",
                    "execution-time",
                    "memory-bytes",
                    "pipeline",
                ]);
                hasSemanticLead = true;
            }

            // Operators with no column list of their own get an output schema derived bottom-up, shown used-first like scans.
            if (
                !properties.has("output columns") &&
                nodeTag !== "execution-target" &&
                nodeTag !== "executiontarget" &&
                nodeTag !== "insert"
            ) {
                setColumnPreview("output columns", computeOutputIus(rawNode));
                // Front `output columns` only when the operator has no lead of its own, so a semantic lead stays visible.
                if (!hasSemanticLead && properties.has("output columns")) {
                    reorderProperties(properties, ["output columns"]);
                }
            }

            // A set-op input's output schema is authoritatively the set op's columns — overwrite the bottom-up derivation to match.
            const setOpCols = setOpInputColumns.get(rawNode);
            if (setOpCols !== undefined && setOpCols.length > 0) {
                columnLists.delete("output columns");
                // Re-resolve names from stored IUs now (after the alias flood filled `iuAliases`), else a later-aliased column mismatches.
                const resolved = setOpCols.map((c) => (c.iu !== undefined ? {name: outputColumnName(c.iu), iu: c.iu} : c));
                setColumnPreview("output columns", resolved);
            }
        }

        if (nodeType == "operator") {
            const operatorId = properties?.get("operator-id");
            if (operatorId !== undefined) {
                conversionState.operatorsById.set(operatorId, convertedNode);
            }
        }

        if (renderingConfig.crosslinkSourceKey) {
            const sourceId = properties?.get(renderingConfig.crosslinkSourceKey);
            if (sourceId !== undefined) {
                conversionState.crosslinks.push({
                    source: convertedNode,
                    targetOpId: sourceId,
                });
            }
        }

        // Keep `operator-id` last (bookkeeping, not semantics); delete+re-set moves it to the Map's end.
        for (const key of ["operator-id", "operatorId"]) {
            const value = properties.get(key);
            if (value !== undefined) {
                properties.delete(key);
                properties.set(key, value);
            }
        }

        // Flag a projection emitting the same output name twice; carry names for insights and show a `duplicate-columns` row.
        if (duplicateColumns.length > 0) {
            convertedNode.duplicateColumns = duplicateColumns;
            const dupPreview = formatColumnPreview(duplicateColumns)!;
            if (duplicateColumns.length > COLUMN_PREVIEW_COUNT) columnLists.set("duplicate-columns", duplicateColumns);
            // Insert right after `output columns` without disturbing other order.
            const rebuilt = new Map<string, string>();
            for (const [k, v] of properties) {
                rebuilt.set(k, v);
                if (k === "output columns") rebuilt.set("duplicate-columns", dupPreview);
            }
            properties.clear();
            for (const [k, v] of rebuilt) properties.set(k, v);
        }

        // Carry full column lists (only set when a preview was truncated) so the UI can expand elided columns.
        if (columnLists.size > 0) {
            convertedNode.columnLists = columnLists;
        }

        return convertedNode;
    } else if (Array.isArray(rawNode)) {
        const listOfObjects = [] as TreeNode[];
        for (let index = 0; index < rawNode.length; ++index) {
            const value = rawNode[index];
            const name = `${parentKey}.${index}`;
            let innerNode = convertHyperNode(value, name, conversionState, parentOperator);
            if (Array.isArray(innerNode)) {
                innerNode = {children: innerNode};
            }
            if (!innerNode.name) innerNode.name = name;
            listOfObjects.push(innerNode);
        }
        return listOfObjects;
    }
    throw new Error("Invalid Hyper query plan");
}

function resolveCrosslinks(state: ConversionState): Crosslink[] {
    const crosslinks = [] as Crosslink[];
    for (const link of state.crosslinks) {
        const target = state.operatorsById.get(link.targetOpId);
        if (target !== undefined) {
            crosslinks.push({source: link.source, target: target});
        }
    }
    return crosslinks;
}

// Total a numeric field across a list, so insights can size each operator's share against a threshold.
function sumBy<T>(items: T[], pick: (item: T) => number): number {
    return items.reduce((total, item) => total + pick(item), 0);
}

// Sets the edge widths, relative to the number of output tuples
function setEdgeWidths(state: ConversionState) {
    const maxWidth = state.edgeWidths.reduce((p, v) => (p > v.width ? p : v.width), 0);
    const minWidth = state.edgeWidths.reduce((p, v) => (p < v.width ? p : v.width), Infinity);
    if (minWidth == maxWidth) return;
    const factor = Math.max(maxWidth - minWidth, minWidth);
    for (const edge of state.edgeWidths) {
        edge.node.edgeWidth = (edge.width - minWidth) / factor;
    }
}

// A raw pipeline entry, as parsed from the `pipelines` array of the plan.
interface RawPipeline {
    id: number;
    operatorIds: number[];
}

// Propagates display names along `target`<-`source` links to a fixpoint, resolving rename chains; writes `iuDisplayNames`.
function propagateDisplayNames(links: {target: string; source: string}[]): void {
    let changed = true;
    let passes = 0;
    while (changed && passes++ < links.length) {
        changed = false;
        for (const {target, source} of links) {
            const sourceName = iuDisplayNames.get(source);
            if (sourceName !== undefined && !iuDisplayNames.has(target)) {
                iuDisplayNames.set(target, sourceName);
                changed = true;
            }
        }
    }
}

function parsePipelines(pipelinesJson: Json): RawPipeline[] {
    if (!Array.isArray(pipelinesJson)) {
        return [];
    }
    const pipelines: RawPipeline[] = [];
    for (const entry of pipelinesJson) {
        if (typeof entry !== "object" || Array.isArray(entry) || entry === null) continue;
        const id = entry["id"];
        const operators = entry["operators"];
        if (typeof id !== "number" || !Array.isArray(operators)) continue;
        const operatorIds = operators.filter((o): o is number => typeof o === "number");
        pipelines.push({id, operatorIds});
    }
    return pipelines;
}

// Colors pipeline bars/edges/icons in one pre-order DFS; each pipeline is colored on first sight so colors track tree position.
function assignPipelineColors(
    root: TreeNode,
    operatorsById: Map<string, TreeNode>,
    pipelines: RawPipeline[],
    crosslinks: Crosslink[],
): void {
    // Resolve each pipeline to its tree nodes; `color` fills lazily on first sight (empty = not yet seen).
    interface ResolvedPipeline {
        id: number;
        nodes: TreeNode[];
        color: string;
    }
    const resolved: ResolvedPipeline[] = pipelines.map((p) => ({
        id: p.id,
        nodes: p.operatorIds.map((opId) => operatorsById.get(opId.toString())!),
        color: "",
    }));

    // Per node, every pipeline it belongs to; kept local so "pipeline" never leaks into the presentation model, which sees only colors.
    const nodePipelines = new Map<TreeNode, ResolvedPipeline[]>();
    for (const p of resolved) {
        for (const node of p.nodes) pushToList(nodePipelines, node, p);
    }

    // A crosslink feeds its source like a child but isn't a tree child; treat target as an extra child so the below-bar shows.
    const crosslinkChildren = new Map<TreeNode, TreeNode[]>();
    for (const link of crosslinks) pushToList(crosslinkChildren, link.source, link.target);

    let nextColor = 0;
    const walk = (node: TreeNode, parent: TreeNode | undefined) => {
        const nodePs = nodePipelines.get(node);
        if (nodePs) {
            for (const p of nodePs) if (p.color === "") p.color = pipelineColor(nextColor++);

            // Order segments by the first child carrying each pipeline so bars line up with branches below; ties keep order via stable sort.
            const childOrder = new Map<number, number>();
            const children = [...allChildren(node), ...(crosslinkChildren.get(node) ?? [])];
            children.forEach((child, idx) => {
                const childPs = nodePipelines.get(child);
                if (!childPs) return;
                for (const p of childPs) if (!childOrder.has(p.id)) childOrder.set(p.id, idx);
            });
            const ordered = (ps: ResolvedPipeline[]): ResolvedPipeline[] =>
                [...ps].sort((a, b) => (childOrder.get(a.id) ?? Infinity) - (childOrder.get(b.id) ?? Infinity));

            // Outgoing (above): pipelines shared with the parent; the root gets no bar above.
            let outgoing: ResolvedPipeline[] = [];
            if (parent) {
                const parentPs = nodePipelines.get(parent);
                const parentPipelineIds = parentPs ? new Set(parentPs.map((p) => p.id)) : new Set<number>();
                outgoing = nodePs.filter((p) => parentPipelineIds.has(p.id));
            }
            node.barsAbove = ordered(outgoing).map((p) => p.color);
            if (outgoing.length) node.edgeColors = node.barsAbove;

            // Incoming (below): pipelines shared with an operator child; a leaf gets no bar below.
            const incoming = nodePs.filter((p) => childOrder.has(p.id));
            node.barsBelow = ordered(incoming).map((p) => p.color);

            // Tint the icon (and minimap) with the right-most pipeline color, unless already colored (e.g. the red error highlight wins).
            if (!node.iconColor) {
                const all = ordered(nodePs);
                node.iconColor = all[all.length - 1].color;
            }
        }
        for (const child of allChildren(node)) walk(child, node);
    };
    walk(root, undefined);
}

function convertHyperPlan(node: Json, pipelines?: Json): TreeDescription {
    const conversionState = {
        operatorsById: new Map<string, TreeNode>(),
        crosslinks: [],
        edgeWidths: [],
        runtimes: [],
        memories: [],
        scanProcessed: [],
        metadata: new Map<string, string>(),
    } as ConversionState;
    // Pre-pass: recover internal-IU -> real-column-name map and the set of referenced IUs (so previews lead with used columns). Per plan.
    iuDisplayNames = new Map<string, string>();
    iuAliases = new Map<string, string>();
    referencedIus = new Set<string>();
    directRefsCache = new WeakMap<object, Set<string>>();
    outputIuCache = new WeakMap<object, OutputColumn[]>();
    setOpInputColumns = new WeakMap<object, OutputColumn[]>();
    const mappingLinks: {target: string; source: string}[] = [];
    collectIuInfo(node, iuDisplayNames, referencedIus, mappingLinks);
    // Propagates display names across `explicit-scan`/`temp` renames to a fixpoint, so a temp-of-a-temp chain resolves to the origin.
    propagateDisplayNames(mappingLinks);
    // Give each set-op `map` target (`setCastN = cast(col)`) its source column's real name instead of the opaque `setCast`.
    const renameLinks: {target: string; source: string}[] = [];
    collectMapRenameLinks(node, renameLinks);
    propagateDisplayNames(renameLinks);
    // Build the undirected "same logical column" graph; two flood passes below walk its components: base-name recovery, then alias fill.
    const aliasLinks: {a: string; b: string}[] = [];
    const aliasSeeds = new Map<string, string>();
    const computedSources = new Map<string, string[]>();
    collectAliasInfo(node, aliasLinks, aliasSeeds, computedSources);
    const adjacency = new Map<string, string[]>();
    const addEdge = (a: string, b: string) => {
        pushToList(adjacency, a, b);
        pushToList(adjacency, b, a);
    };
    for (const {target, source} of mappingLinks) addEdge(target, source);
    for (const {a, b} of aliasLinks) addEdge(a, b);
    // A component contains only IUs provably the SAME logical column — edges are renames/passthroughs/set-op links, computations add none.
    const components: string[][] = [];
    const visited = new Set<string>();
    for (const start of adjacency.keys()) {
        if (visited.has(start)) continue;
        const component: string[] = [];
        const stack = [start];
        visited.add(start);
        while (stack.length > 0) {
            const cur = stack.pop() as string;
            component.push(cur);
            for (const nb of adjacency.get(cur) ?? []) {
                if (!visited.has(nb)) {
                    visited.add(nb);
                    stack.push(nb);
                }
            }
        }
        components.push(component);
    }
    // Base-name recovery: adopt only if the component resolves to exactly ONE; `veto` blocks a computed member hiding disagreement.
    for (const component of components) {
        const baseNames = new Set<string>();
        let veto = false;
        for (const iu of component) {
            const direct = iuDisplayNames.get(iu);
            if (direct !== undefined) {
                baseNames.add(direct);
                continue;
            }
            const leaves = computedSources.get(iu);
            if (leaves === undefined) continue; // a passthrough / set-op output IU still awaiting a name
            // A single-source computed value (a cast) traces to its origin; anything else is a new column, not foldable into a neighbor.
            const leafName = leaves.length === 1 ? iuDisplayNames.get(leaves[0]) : undefined;
            if (leafName !== undefined) baseNames.add(leafName);
            else veto = true;
        }
        if (veto || baseNames.size !== 1) continue;
        const base = baseNames.values().next().value as string;
        for (const iu of component) {
            if (!iuDisplayNames.has(iu)) iuDisplayNames.set(iu, base);
        }
    }
    // `propagateSetOpNames` pushes set-op names onto inputs; it fills `outputIuCache` with pre-propagation names, so discard after.
    propagateSetOpNames(node);
    outputIuCache = new WeakMap<object, OutputColumn[]>();
    // Alias flood-fill: walk each component from its aliased IU, recording aliases that differ from base name if seeds agree on one.
    for (const component of components) {
        const seededAliases = new Set<string>();
        for (const iu of component) {
            const a = aliasSeeds.get(iu);
            if (a !== undefined) seededAliases.add(a);
        }
        if (seededAliases.size !== 1) continue;
        const alias = seededAliases.values().next().value as string;
        for (const iu of component) {
            if (!iuAliases.has(iu) && iuDisplayNames.get(iu) !== alias) iuAliases.set(iu, alias);
        }
    }
    // The runtime statistics block was renamed from `analyze` to `statistics` in the FORMAT JSON rework (W-22563058); read both.
    const errorMsg =
        tryGetPropertyPath(node, ["statistics", "error", "message", "original"]) ??
        tryGetPropertyPath(node, ["analyze", "error", "message", "original"]);
    if (errorMsg) {
        conversionState.metadata.set("Error", forceToString(errorMsg));
    }

    const root = convertHyperNode(node, "result", conversionState);
    if (Array.isArray(root)) {
        throw new Error("Invalid Hyper query plan");
    }
    // Plan-wide totals the highlight heatmaps scale against; `deriveNodeDisplay` derives colors/tooltips from per-node signals plus these.
    const planCpuTotal = sumBy(conversionState.runtimes, (v) => v.time);
    const planMemoryTotal = sumBy(conversionState.memories, (v) => v.bytes);
    const planProcessedTotal = sumBy(conversionState.scanProcessed, (v) => v.processed);
    setEdgeWidths(conversionState);
    const crosslinks = resolveCrosslinks(conversionState);
    if (pipelines !== undefined) {
        assignPipelineColors(root, conversionState.operatorsById, parsePipelines(pipelines), crosslinks);
    }
    // Packages highlight heuristics into an insights capability; opts the tree into the insights panel, keeps rendering db-agnostic.
    const insights = createInsightsCapability(root, planCpuTotal, planProcessedTotal, planMemoryTotal);
    // Initial highlight bake via the same code path a later slider edit takes, so load-time and re-highlighted state can't diverge.
    insights.rehighlight({});
    return {
        root,
        crosslinks,
        metadata: conversionState.metadata,
        planSource: "hyper",
        insights,
    };
}

function convertOptimizerSteps(node: Json): TreeDescription | undefined {
    if (typeof node !== "object" || Array.isArray(node) || node === null) return undefined;
    if (Object.getOwnPropertyNames(node).length != 1) return undefined;
    if (!node.hasOwnProperty("optimizersteps")) return undefined;
    const steps = node["optimizersteps"];
    if (!Array.isArray(steps)) return undefined;

    const crosslinks: Crosslink[] = [];
    const children: TreeNode[] = [];
    const properties = new Map<string, string>();
    for (const step of steps) {
        if (typeof step !== "object" || Array.isArray(step) || step === null) return undefined;
        if (Object.getOwnPropertyNames(step).length != 2) return undefined;
        if (!step.hasOwnProperty("name")) return undefined;
        if (!step.hasOwnProperty("plan")) return undefined;
        const name = step["name"];
        const plan = step["plan"];
        if (typeof name !== "string") return undefined;

        const {root: childRoot, crosslinks: newCrosslinks, metadata: newProperties} = convertHyperPlan(plan);
        crosslinks.push(...(newCrosslinks ?? []));
        children.push({name: name, children: [childRoot]});
        for (const [k, v] of newProperties ?? []) properties.set(k, v);
    }
    const root = {name: "optimizersteps", children: children};
    // Sub-plans carry baked highlights, but the stitched tree has no plan-wide totals, so thresholds aren't live-tunable (docs-only).
    return {root, crosslinks, metadata: properties, planSource: "hyper", insights: staticInsightsCapability()};
}

// Detect the `{tree, pipelines}` envelope emitted by `EXPLAIN (..., PIPELINES, ...)`.
function hasPipelineEnvelope(json: Json): json is JsonObject {
    return (
        typeof json === "object" &&
        !Array.isArray(json) &&
        json !== null &&
        hasOwnProperty(json, "tree") &&
        hasOwnProperty(json, "pipelines") &&
        typeof json["tree"] === "object"
    );
}

export function loadHyperPlan(json: Json): TreeDescription {
    if (hasPipelineEnvelope(json)) {
        return convertHyperPlan(json["tree"], json["pipelines"]);
    }
    return convertOptimizerSteps(json) ?? convertHyperPlan(json);
}

function tryStripPrefix(str, pre) {
    return str.startsWith(pre) ? str.substring(pre.length) : str;
}

export function loadHyperPlanFromText(graphString: string): TreeDescription {
    // Strip `plan` prefix if it exists. This is written by `sql_hyper` if output is forwarded using `\o`
    graphString = tryStripPrefix(graphString, "plan\n");

    let json: Json;
    try {
        json = JSON.parse(graphString);
    } catch (err) {
        throw new Error("JSON parse failed with '" + err + "'.", {cause: err});
    }
    return loadHyperPlan(json);
}
