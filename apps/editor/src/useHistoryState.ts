import { useCallback, useState } from 'react';

interface HistoryEntry<T> { label: string; value: T }

export function useHistoryState<T>(initial: T) {
  const [present, setPresent] = useState(initial);
  const [past, setPast] = useState<Array<HistoryEntry<T>>>([]);
  const [future, setFuture] = useState<Array<HistoryEntry<T>>>([]);

  const apply = useCallback((label: string, update: T | ((current: T) => T)) => {
    setPresent((current) => {
      const next = typeof update === 'function' ? (update as (value: T) => T)(current) : update;
      if (Object.is(current, next)) return current;
      setPast((entries) => [...entries.slice(-99), { label, value: structuredClone(current) }]);
      setFuture([]);
      return next;
    });
  }, []);

  const undo = useCallback(() => {
    setPast((entries) => {
      const previous = entries[entries.length - 1];
      if (!previous) return entries;
      setPresent((current) => { setFuture((items) => [{ label: previous.label, value: structuredClone(current) }, ...items]); return previous.value; });
      return entries.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setFuture((entries) => {
      const next = entries[0];
      if (!next) return entries;
      setPresent((current) => { setPast((items) => [...items, { label: next.label, value: structuredClone(current) }]); return next.value; });
      return entries.slice(1);
    });
  }, []);

  const reset = useCallback((value: T) => {
    setPresent(structuredClone(value));
    setPast([]);
    setFuture([]);
  }, []);

  return { value: present, apply, undo, redo, reset, canUndo: past.length > 0, canRedo: future.length > 0, undoLabel: past[past.length - 1]?.label, redoLabel: future[0]?.label };
}
