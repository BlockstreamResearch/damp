export type AppRole = "holder" | "issuer";

export function roleSwitchNavigation(role: AppRole) {
  return role === "holder"
    ? { to: "/admin" as const, label: "Issuer console", mobileLabel: "Issuer" }
    : { to: "/wallet" as const, label: "Holder wallet", mobileLabel: "Wallet" };
}

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
