export type AppRole = "holder" | "issuer";

export function activeNavigationTarget(
  pathname: string,
  items: ReadonlyArray<{ to: string }>,
) {
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;

  return items.reduce<string | undefined>((selected, item) => {
    const matches = normalizedPath === item.to || normalizedPath.startsWith(`${item.to}/`);
    if (!matches || (selected && selected.length >= item.to.length)) return selected;
    return item.to;
  }, undefined);
}
