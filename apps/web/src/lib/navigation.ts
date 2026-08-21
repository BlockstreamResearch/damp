export type AppRole = "holder" | "issuer";

export function contextualDocumentTitle(title: string) {
  return `${title} · Simplicity AMP`;
}

export function appRoleForPath(pathname: string): AppRole | undefined {
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (normalizedPath === "/admin" || normalizedPath.startsWith("/admin/")) return "issuer";
  if (normalizedPath === "/wallet" || normalizedPath.startsWith("/wallet/")) return "holder";
  return undefined;
}

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
