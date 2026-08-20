import {
  Outlet,
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { AdminDashboard, AdminReissue, AdminSetup } from "./screens/admin";
import { WalletDashboard, WalletReceive, WalletSend } from "./screens/wallet";

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
  createRoute({ getParentRoute: () => rootRoute, path: "/admin", component: AdminDashboard }),
  createRoute({ getParentRoute: () => rootRoute, path: "/admin/setup", component: AdminSetup }),
  createRoute({ getParentRoute: () => rootRoute, path: "/admin/reissue", component: AdminReissue }),
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
