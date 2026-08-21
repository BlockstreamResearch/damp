import { describe, expect, it } from "vitest";

import { activeNavigationTarget, appRoleForPath } from "../lib/navigation";

const nav = {
  issuer: [{ to: "/admin" }, { to: "/admin/setup" }, { to: "/admin/reissue" }],
  holder: [{ to: "/wallet" }, { to: "/wallet/send" }, { to: "/wallet/receive" }],
} as const;

function selected(role: keyof typeof nav, pathname: string) {
  return activeNavigationTarget(pathname, nav[role]);
}

describe("activeNavigationTarget", () => {
  it.each([
    ["issuer", "/admin", "/admin"],
    ["issuer", "/admin/setup", "/admin/setup"],
    ["issuer", "/admin/reissue", "/admin/reissue"],
    ["holder", "/wallet", "/wallet"],
    ["holder", "/wallet/send", "/wallet/send"],
    ["holder", "/wallet/receive", "/wallet/receive"],
  ] as const)("selects the %s item for %s", (role, pathname, expected) => {
    expect(selected(role, pathname)).toBe(expected);
  });

  it.each([
    ["issuer", "/admin/setup/import", "/admin/setup"],
    ["issuer", "/admin/reissue/review", "/admin/reissue"],
    ["holder", "/wallet/send/review", "/wallet/send"],
    ["holder", "/wallet/receive/share", "/wallet/receive"],
  ] as const)("uses the most specific %s item for nested path %s", (role, pathname, expected) => {
    expect(selected(role, pathname)).toBe(expected);
  });

  it("normalizes trailing slashes used by direct and reloaded links", () => {
    expect(selected("issuer", "/admin/setup///")).toBe("/admin/setup");
    expect(selected("holder", "/wallet/send/")).toBe("/wallet/send");
  });

  it("does not select an item from the other role or an unrelated path", () => {
    expect(selected("issuer", "/wallet/send")).toBeUndefined();
    expect(selected("holder", "/admin/setup")).toBeUndefined();
    expect(selected("holder", "/wallets")).toBeUndefined();
  });
});

describe("appRoleForPath", () => {
  it.each([
    ["/admin", "issuer"],
    ["/admin/setup", "issuer"],
    ["/admin/reissue/review", "issuer"],
    ["/wallet", "holder"],
    ["/wallet/send", "holder"],
    ["/wallet/receive/share/", "holder"],
  ] as const)("owns %s with the %s shell", (pathname, expected) => {
    expect(appRoleForPath(pathname)).toBe(expected);
  });

  it("does not assign holder or issuer chrome to unrelated routes", () => {
    expect(appRoleForPath("/wallets")).toBeUndefined();
    expect(appRoleForPath("/administrator")).toBeUndefined();
  });
});
