export type ShelfWindow = {
  start: number;
  end: number;
  focusOffset: number;
};

export function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(index, count - 1));
}

export function getShelfWindow({
  focusedIndex,
  count,
  overscanBefore,
  overscanAfter
}: {
  focusedIndex: number;
  count: number;
  overscanBefore: number;
  overscanAfter: number;
}): ShelfWindow {
  if (count <= 0) {
    return { start: 0, end: 0, focusOffset: 0 };
  }

  const clampedFocus = clampIndex(focusedIndex, count);
  const start = Math.max(0, clampedFocus - Math.max(0, overscanBefore));
  const end = Math.min(count, clampedFocus + Math.max(0, overscanAfter) + 1);

  return {
    start,
    end,
    focusOffset: clampedFocus - start
  };
}

export function getGridRenderCount({
  count,
  focusedIndex,
  columns,
  currentRenderCount,
  minimumRows,
  overscanRows,
  batchRows
}: {
  count: number;
  focusedIndex: number;
  columns: number;
  currentRenderCount: number;
  minimumRows: number;
  overscanRows: number;
  batchRows: number;
}): number {
  if (count <= 0) return 0;

  const safeColumns = Math.max(1, columns);
  const minimumCount = Math.max(1, minimumRows) * safeColumns;
  const focusedCount = clampIndex(focusedIndex, count) + 1 + Math.max(0, overscanRows) * safeColumns;
  const requested = Math.max(currentRenderCount, minimumCount, focusedCount);
  const batchSize = Math.max(1, batchRows) * safeColumns;
  const batched = Math.ceil(requested / batchSize) * batchSize;

  return Math.min(count, batched);
}
