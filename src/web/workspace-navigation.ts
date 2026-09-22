/** Keep in sync with the tab/overflow widths and gap in style.css. */
export function workspaceTabs(ids: string[], active: string, width: number) {
  const capacity =
    ids.length * 204 - 4 <= width
      ? ids.length
      : Math.max(1, Math.floor((Math.max(0, width) - 104) / 204));
  const visible = ids.slice(0, capacity);
  if (ids.includes(active) && !visible.includes(active))
    visible[visible.length - 1] = active;
  const shown = new Set(visible);
  return { visible, hidden: ids.filter((id) => !shown.has(id)) };
}
