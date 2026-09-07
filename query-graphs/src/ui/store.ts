import {create} from "zustand";
import {immer} from "zustand/middleware/immer";
import {devtools} from "zustand/middleware";

export interface NodeDimensions {
    headWidth?: number;
    headHeight?: number;
    bodyWidth?: number;
    bodyHeight?: number;
}

interface GraphRenderingState {
    init: (expandedSubtrees: Record<string, boolean>, highlightThresholds: Record<string, number>) => void;
    // `expandedNodes` tracks which nodes show their property detail panel (toggled by a plain click).
    expandedNodes: Record<string, boolean>;
    toggleExpandedNode: (nodeId: string) => void;
    // `expandedSubtrees` tracks which nodes reveal their `collapsedChildren` (toggled by shift-click or the +/- handle).
    expandedSubtrees: Record<string, boolean>;
    toggleExpandedSubtree: (nodeId: string) => void;
    // Measured on-screen head/body sizes, reported by a ResizeObserver and fed back into layout.
    nodeDimensions: Record<string, NodeDimensions>;
    updateNodeDimensions: (entries: ResizeObserverEntry[]) => unknown;
    // When true, non-flagged nodes are dimmed so highlighted issues stand out (focus mode).
    focusIssues: boolean;
    setFocusIssues: (focus: boolean) => void;
    // Current values of the plan's adjustable highlight thresholds, keyed by the opaque threshold key the
    // loader's insights capability supplies. Editing one re-highlights the graph without reloading the
    // plan (see QueryGraph.tsx). `defaultHighlightThresholds` is the loader's seed, used by reset. Both
    // are re-seeded from the loaded tree's `insights.thresholds` on `init`.
    highlightThresholds: Record<string, number>;
    defaultHighlightThresholds: Record<string, number>;
    setThreshold: (key: string, value: number) => void;
    resetThresholds: () => void;
}

export const useGraphRenderingStore = create<GraphRenderingState>()(
    devtools(
        immer((set, get) => ({
            expandedNodes: {},
            expandedSubtrees: {},
            nodeDimensions: {},
            focusIssues: false,
            highlightThresholds: {},
            defaultHighlightThresholds: {},
            init: (expandedSubtrees, highlightThresholds) => {
                set((state) => {
                    state.expandedNodes = {};
                    state.expandedSubtrees = expandedSubtrees;
                    state.nodeDimensions = {};
                    state.focusIssues = false;
                    state.highlightThresholds = {...highlightThresholds};
                    state.defaultHighlightThresholds = {...highlightThresholds};
                });
            },
            setFocusIssues: (focus) =>
                set((state) => {
                    state.focusIssues = focus;
                }),
            setThreshold: (key, value) =>
                set((state) => {
                    state.highlightThresholds[key] = value;
                }),
            resetThresholds: () =>
                set((state) => {
                    state.highlightThresholds = {...state.defaultHighlightThresholds};
                }),
            toggleExpandedNode: (nodeId) =>
                set((state) => {
                    state.expandedNodes[nodeId] = !get().expandedNodes[nodeId];
                }),
            toggleExpandedSubtree: (nodeId) =>
                set((state) => {
                    state.expandedSubtrees[nodeId] = !get().expandedSubtrees[nodeId];
                }),
            updateNodeDimensions: (entries: ResizeObserverEntry[]) =>
                set((state) => {
                    for (const e of entries) {
                        // Figure out which node was changed
                        const target = e.target as HTMLElement;
                        const id = target.closest(".react-flow__node")?.getAttribute("data-id");
                        if (id === null || id === undefined) continue;
                        // Create an entry for this node, if we don't have it, yet
                        if (!state.nodeDimensions[id]) {
                            state.nodeDimensions[id] = {};
                        }
                        // Update head/body dimensions
                        if (target.classList.contains("qg-graph-node-head")) {
                            state.nodeDimensions[id].headWidth = target.offsetWidth;
                            state.nodeDimensions[id].headHeight = target.offsetHeight;
                        } else if (target.classList.contains("qg-graph-node-body")) {
                            state.nodeDimensions[id].bodyWidth = target.offsetWidth;
                            state.nodeDimensions[id].bodyHeight = target.offsetHeight;
                        }
                    }
                }),
        })),
    ),
);
