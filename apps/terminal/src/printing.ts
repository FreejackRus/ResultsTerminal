export type PrintOutcome = {
  completed: string[];
  failed: string[];
  uncertain?: string;
  cancelled: boolean;
};
export async function printBatch(
  ids: readonly string[],
  prepare: (id: string) => Promise<number[]>,
  submit: (id: string, bytes: number[]) => Promise<void>,
  active: () => boolean,
  progress: (id: string) => void,
): Promise<PrintOutcome> {
  const result: PrintOutcome = { completed: [], failed: [], cancelled: false };
  for (const [idIndex, id] of ids.entries()) {
    if (!active()) {
      result.cancelled = true;
      break;
    }
    progress(id);
    let bytes: number[];
    try {
      bytes = await prepare(id);
    } catch {
      result.failed.push(id);
      continue;
    }
    if (!active()) {
      result.cancelled = true;
      break;
    }
    try {
      await submit(id, bytes);
      result.completed.push(id);
    } catch (error) {
      if (
        error === 'NOT_SUBMITTED' ||
        (error instanceof Error && error.message === 'NOT_SUBMITTED')
      ) {
        result.failed.push(...ids.slice(idIndex));
        break;
      }
      result.uncertain = id;
      result.failed.push(...ids.slice(idIndex + 1));
      break;
    }
  }
  return result;
}
