export function auditableViews(items) {
  return items.filter(({ visible }) => visible).map(({ view }) => view);
}
