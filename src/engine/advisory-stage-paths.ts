/** Keep native executors and the upstream storage adapter on the same artifact layout. */
export function advisoryStageWriteRoot(root: string, runId: string, role: string | undefined, agent: string): string {
  const subdirectory = role === "product-owner" ? "handoff/" : agent === "BRD Builder" ? "brd/" : "";
  return `${root}/${runId}/${subdirectory}`;
}
