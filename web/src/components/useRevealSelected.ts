import { useEffect, useRef } from "react";

// Keeps a list's selected row visible when the selection comes from outside
// the list (a search hit, or a jump from the Compare page). A row that is
// already on screen is left where it is, so ordinary clicks don't move the list.
export function useRevealSelected<T extends HTMLElement>(selected: unknown, rowSelector = ".class-row.selected") {
  const listRef = useRef<T>(null);

  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector(rowSelector);
    if (!list || !row) return;
    const listBox = list.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    if (rowBox.top < listBox.top || rowBox.bottom > listBox.bottom) {
      row.scrollIntoView({ block: "center" });
    }
  }, [selected, rowSelector]);

  return listRef;
}
