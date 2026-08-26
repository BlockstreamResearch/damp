import {
  Outlet,
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { AdminDashboard, AdminHolders, AdminReissue, AdminReport, AdminSetup } from "./screens/admin";
import { WalletDashboard, WalletImport, WalletReceive, WalletSend } from "./screens/wallet";

const rootRoute = createRootRoute({ component: Outlet });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/wallet" });
  },
});

const routes = [
  createRoute({ getParentRoute: () => rootRoute, path: "/wallet", component: WalletDashboard }),
  createRoute({ getParentRoute: () => rootRoute, path: "/wallet/send", component: WalletSend }),
  createRoute({ getParentRoute: () => rootRoute, path: "/wallet/receive", component: WalletReceive }),
  createRoute({ getParentRoute: () => rootRoute, path: "/wallet/import", component: WalletImport }),
  createRoute({ getParentRoute: () => rootRoute, path: "/admin", beforeLoad: () => { throw redirect({ to: "/admin/setup" }); } }),
  createRoute({ getParentRoute: () => rootRoute, path: "/admin/blacklist", component: AdminDashboard }),
  createRoute({ getParentRoute: () => rootRoute, path: "/admin/setup", component: AdminSetup }),
  createRoute({ getParentRoute: () => rootRoute, path: "/admin/reissue", component: AdminReissue }),
  createRoute({ getParentRoute: () => rootRoute, path: "/admin/holders", component: AdminHolders }),
  createRoute({ getParentRoute: () => rootRoute, path: "/admin/report", component: AdminReport }),
];

const routeTree = rootRoute.addChildren([indexRoute, ...routes]);

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
