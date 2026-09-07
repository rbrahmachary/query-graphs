import {ReactFlow, MiniMap, Controls, ReactFlowProvider} from "@xyflow/react";
import "@xyflow/react/dist/base.css";

import {layoutTree} from "./tree-layout";
import type {TreeDescription, TreeNode} from "../tree-description";
import {allChildren, visitTreeNodes} from "../tree-description";
import type {ReactNode} from "react";
import {useMemo, useEffect, useRef} from "react";
import {QueryNode} from "./QueryNode";
import type {QueryGraphNode} from "./QueryNode";
import {QueryEdge} from "./QueryEdge";
import {PlanInsights} from "./PlanInsights";
import {useGraphRenderingStore} from "./store";
import "./QueryGraph.css";

interface QueryGraphProps {
    treeDescription: TreeDescription;
    children: ReactNode | ReactNode[];
}

function minimapNodeColor(n: QueryGraphNode): string {
    // A costly scan's proportional red takes precedence so heavy scans are spottable in the minimap;
    // otherwise fall back to the runtime-hotspot tint, then the memory-hotspot tint, then the icon color.
    if (n.data.highlightNode === "costly-scan" && n.data.costlyScanColor) return n.data.costlyScanColor;
    if (n.data.nodeColor) return n.data.nodeColor;
    if (n.data.memoryColor) return n.data.memoryColor;
    if (n.data.iconColor) return n.data.iconColor;
    return "hsl(0, 0%, 72%)";
}

const nodeTypes = {
    querynode: QueryNode,
};

const edgeTypes = {
    queryedge: QueryEdge,
};

function QueryGraphInternal({treeDescription, children}: QueryGraphProps) {
    // Assign ids to all nodes
    const nodeIdMapping = useMemo(() => {
        let nextId = 0;
        const nodeIds = new Map<TreeNode, string>();
        visitTreeNodes(
            treeDescription.root,
            (d) => {
                nodeIds.set(d, "" + nextId++);
            },
            allChildren,
        );
        return nodeIds;
    }, [treeDescription]);

    // Initialize our state using the correct "expandedByDefault" state
    const initGraphStore = useGraphRenderingStore((s) => s.init);
    useMemo(() => {
        const expandedSubtrees = {};
        visitTreeNodes(
            treeDescription.root,
            (n) => {
                if (n.expandedByDefault) {
                    expandedSubtrees[nodeIdMapping.get(n)!] = true;
                }
            },
            allChildren,
        );
        // Seed the adjustable highlight thresholds from the loader's insights capability, so the
        // insights panel's sliders start at the loader's defaults and "Reset to defaults" can restore
        // them. Loaders without live-tunable insights supply an empty threshold list.
        const highlightThresholds: Record<string, number> = {};
        for (const t of treeDescription.insights?.thresholds ?? []) {
            highlightThresholds[t.key] = t.value;
        }
        initGraphStore(expandedSubtrees, highlightThresholds);
    }, [treeDescription, initGraphStore, nodeIdMapping]);

    // Create a ResizeObserver to keep track of the sizes of the nodes
    const resizeObserverRef = useRef<ResizeObserver | undefined>(undefined);
    const updateNodeDimensions = useGraphRenderingStore((s) => s.updateNodeDimensions);
    const resizeObserver = useMemo(() => {
        resizeObserverRef.current?.disconnect();
        const observer = new ResizeObserver(updateNodeDimensions);
        resizeObserverRef.current = observer;
        return observer;
    }, [updateNodeDimensions]);
    useEffect(() => {
        return () => {
            resizeObserverRef.current?.disconnect();
        };
    }, []);

    // Layout the tree, using the actual measured sizes of the DOM nodes
    const nodeDimensions = useGraphRenderingStore((s) => s.nodeDimensions);
    const expandedNodes = useGraphRenderingStore((s) => s.expandedNodes);
    const expandedSubtrees = useGraphRenderingStore((s) => s.expandedSubtrees);
    const focusIssues = useGraphRenderingStore((s) => s.focusIssues);
    const highlightThresholds = useGraphRenderingStore((s) => s.highlightThresholds);
    const layout = useMemo(() => {
        // Re-bake the tree's highlight fields for the current threshold values before laying out. The
        // loader owns this logic (exposed opaquely via `insights.rehighlight`), keeping the layout stage
        // database-agnostic; at the loader's defaults it reproduces the initial bake exactly. Runs before
        // PlanInsights (a child) walks the tree, so its counts stay in sync with the re-highlighted nodes.
        treeDescription.insights?.rehighlight(highlightThresholds);
        return layoutTree(
            treeDescription,
            nodeIdMapping,
            nodeDimensions,
            expandedNodes,
            expandedSubtrees,
            resizeObserver,
            focusIssues,
        );
    }, [
        treeDescription,
        nodeIdMapping,
        nodeDimensions,
        expandedNodes,
        expandedSubtrees,
        resizeObserver,
        focusIssues,
        highlightThresholds,
    ]);

    return (
        <ReactFlow
            nodes={layout.nodes}
            edges={layout.edges}
            nodeOrigin={[0.5, 0]}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            fitViewOptions={{padding: 0.18}}
            minZoom={0.2}
            maxZoom={1.5}
            elementsSelectable={true}
            nodesDraggable={false}
            nodesConnectable={false}
            nodesFocusable={false}
            className={"query-graph"}
        >
            {...Array.isArray(children) ? children : [children]}
            {/* The insights overlay (summary header + legend/tools panel) surfaces the plan-insights
                data a loader bakes into the tree. It's gated on the generic `insights` capability
                rather than a specific plan source, keeping the rendering stage database-agnostic: any
                loader that populates the highlight categories opts in by supplying the capability.
                Loaders that don't (e.g. Postgres) leave it unset and get no panel instead of an
                always-empty one. */}
            {treeDescription.insights ? <PlanInsights treeDescription={treeDescription} nodeIdMapping={nodeIdMapping} /> : null}
            <MiniMap zoomable={true} pannable={true} nodeColor={minimapNodeColor} />
            <Controls showInteractive={false} />
        </ReactFlow>
    );
}

export function QueryGraph(props: QueryGraphProps) {
    return (
        <ReactFlowProvider>
            <QueryGraphInternal {...props} />
        </ReactFlowProvider>
    );
}
