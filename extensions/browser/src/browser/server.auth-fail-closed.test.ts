import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBrowserControlServerFromConfig, stopBrowserControlServer } from "../server.js";
import { getFreePort } from "./test-port.js";

type EnsureBrowserControlAuthResult = {
  auth: {
    token?: string;
    password?: string;
  };
  generatedToken?: string;
};

const mocks = vi.hoisted(() => ({
  controlPort: 0,
  gatewayAuthMode: undefined as "password" | "trusted-proxy" | undefined,
  gatewayAuthToken: undefined as string | undefined,
  gatewayAuthPassword: undefined as unknown,
  gatewayTrustedProxyUserHeader: undefined as string | undefined,
  ensureBrowserControlAuth: vi.fn<() => Promise<EnsureBrowserControlAuthResult>>(async () => {
    throw new Error("read-only config");
  }),
  resolveBrowserControlAuth: vi.fn(() => ({})),
  allowsEmptyBrowserControlAuth: vi.fn(
    (cfg: {
      gateway?: {
        auth?: { mode?: string; password?: unknown; trustedProxy?: { userHeader?: string } };
      };
    }) => {
      const auth = cfg.gateway?.auth;
      return (
        auth?.mode === "trusted-proxy" &&
        typeof auth.trustedProxy?.userHeader === "string" &&
        auth.trustedProxy.userHeader.trim().length > 0 &&
        !(typeof auth.password === "string"
          ? auth.password.trim().length > 0
          : auth.password != null)
      );
    },
  ),
  shouldAutoGenerateBrowserAuth: vi.fn(() => true),
  ensureExtensionRelayForProfiles: vi.fn(async () => {}),
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  const browserConfig = {
    enabled: true,
  };
  const loadConfig = () => {
    const hasAuth =
      Boolean(mocks.gatewayAuthMode) ||
      Boolean(mocks.gatewayAuthToken) ||
      mocks.gatewayAuthPassword != null;
    const auth = hasAuth
      ? {
          mode: mocks.gatewayAuthMode,
          token: mocks.gatewayAuthToken,
          password: mocks.gatewayAuthPassword,
          ...(mocks.gatewayTrustedProxyUserHeader != null
            ? { trustedProxy: { userHeader: mocks.gatewayTrustedProxyUserHeader } }
            : {}),
        }
      : undefined;
    return {
      browser: browserConfig,
      ...(auth ? { gateway: { auth } } : {}),
    };
  };
  return {
    ...actual,
    getRuntimeConfig: loadConfig,
    loadConfig,
  };
});

vi.mock("./config.js", async () => {
  const actual = await vi.importActual<typeof import("./config.js")>("./config.js");
  return {
    ...actual,
    resolveBrowserConfig: vi.fn(() => ({
      enabled: true,
      controlPort: mocks.controlPort,
    })),
  };
});

vi.mock("./control-auth.js", () => ({
  allowsEmptyBrowserControlAuth: mocks.allowsEmptyBrowserControlAuth,
  ensureBrowserControlAuth: mocks.ensureBrowserControlAuth,
  resolveBrowserControlAuth: mocks.resolveBrowserControlAuth,
  shouldAutoGenerateBrowserAuth: mocks.shouldAutoGenerateBrowserAuth,
}));

vi.mock("./routes/index.js", () => ({
  registerBrowserRoutes: vi.fn(() => {}),
}));

vi.mock("./server-context.js", () => ({
  createBrowserRouteContext: vi.fn(() => ({})),
}));

vi.mock("./server-lifecycle.js", () => ({
  ensureExtensionRelayForProfiles: mocks.ensureExtensionRelayForProfiles,
  stopKnownBrowserProfiles: vi.fn(async () => {}),
}));

vi.mock("./pw-ai-state.js", () => ({
  isPwAiLoaded: vi.fn(() => false),
}));

describe("browser control auth bootstrap failures", () => {
  beforeEach(async () => {
    mocks.controlPort = await getFreePort();
    mocks.gatewayAuthMode = undefined;
    mocks.gatewayAuthToken = undefined;
    mocks.gatewayAuthPassword = undefined;
    mocks.gatewayTrustedProxyUserHeader = undefined;
    mocks.ensureBrowserControlAuth.mockClear();
    mocks.resolveBrowserControlAuth.mockClear();
    mocks.allowsEmptyBrowserControlAuth.mockClear();
    mocks.shouldAutoGenerateBrowserAuth.mockClear();
    mocks.ensureExtensionRelayForProfiles.mockClear();
  });

  afterEach(async () => {
    await stopBrowserControlServer();
  });

  it("fails closed when auth bootstrap throws and no auth is configured", async () => {
    const started = await startBrowserControlServerFromConfig();

    expect(started).toBeNull();
    expect(mocks.ensureBrowserControlAuth).toHaveBeenCalledTimes(1);
    expect(mocks.resolveBrowserControlAuth).toHaveBeenCalledTimes(1);
    expect(mocks.ensureExtensionRelayForProfiles).not.toHaveBeenCalled();
  });

  it("fails closed when auth bootstrap resolves empty auth in production-like mode", async () => {
    mocks.ensureBrowserControlAuth.mockResolvedValueOnce({ auth: {} });
    mocks.resolveBrowserControlAuth.mockReturnValueOnce({});
    mocks.shouldAutoGenerateBrowserAuth.mockReturnValueOnce(true);

    const started = await startBrowserControlServerFromConfig();

    expect(started).toBeNull();
    expect(mocks.ensureBrowserControlAuth).toHaveBeenCalledTimes(1);
    expect(mocks.resolveBrowserControlAuth).toHaveBeenCalledTimes(1);
    expect(mocks.ensureExtensionRelayForProfiles).not.toHaveBeenCalled();
  });

  it("fails closed when password mode has no resolved password", async () => {
    mocks.gatewayAuthMode = "password";
    mocks.ensureBrowserControlAuth.mockResolvedValueOnce({ auth: {} });
    mocks.resolveBrowserControlAuth.mockReturnValueOnce({});
    mocks.shouldAutoGenerateBrowserAuth.mockReturnValueOnce(true);

    const started = await startBrowserControlServerFromConfig();

    expect(started).toBeNull();
    expect(mocks.ensureExtensionRelayForProfiles).not.toHaveBeenCalled();
  });

  it("fails closed when password mode drops an inactive token but has no password", async () => {
    mocks.gatewayAuthMode = "password";
    mocks.gatewayAuthToken = "inactive-token";
    mocks.ensureBrowserControlAuth.mockResolvedValueOnce({ auth: {} });
    mocks.resolveBrowserControlAuth.mockReturnValueOnce({});
    mocks.shouldAutoGenerateBrowserAuth.mockReturnValueOnce(true);

    const started = await startBrowserControlServerFromConfig();

    expect(started).toBeNull();
    expect(mocks.ensureExtensionRelayForProfiles).not.toHaveBeenCalled();
  });

  it("starts without browser auth when trusted-proxy mode has no password", async () => {
    mocks.gatewayAuthMode = "trusted-proxy";
    mocks.gatewayTrustedProxyUserHeader = "x-forwarded-user";
    mocks.ensureBrowserControlAuth.mockResolvedValueOnce({ auth: {} });
    mocks.resolveBrowserControlAuth.mockReturnValueOnce({});
    mocks.shouldAutoGenerateBrowserAuth.mockReturnValueOnce(true);

    const started = await startBrowserControlServerFromConfig();

    expect(started).not.toBeNull();
    expect(mocks.ensureExtensionRelayForProfiles).toHaveBeenCalledTimes(1);
  });

  it("fails closed when trusted-proxy mode is missing proxy identity config", async () => {
    mocks.gatewayAuthMode = "trusted-proxy";
    mocks.ensureBrowserControlAuth.mockResolvedValueOnce({ auth: {} });
    mocks.resolveBrowserControlAuth.mockReturnValueOnce({});
    mocks.shouldAutoGenerateBrowserAuth.mockReturnValueOnce(true);

    const started = await startBrowserControlServerFromConfig();

    expect(started).toBeNull();
    expect(mocks.ensureExtensionRelayForProfiles).not.toHaveBeenCalled();
  });

  it("still requires browser auth when trusted-proxy mode has a password", async () => {
    mocks.gatewayAuthMode = "trusted-proxy";
    mocks.gatewayAuthPassword = "browser-password";
    mocks.gatewayTrustedProxyUserHeader = "x-forwarded-user";
    mocks.ensureBrowserControlAuth.mockResolvedValueOnce({ auth: {} });
    mocks.resolveBrowserControlAuth.mockReturnValueOnce({});
    mocks.shouldAutoGenerateBrowserAuth.mockReturnValueOnce(true);

    const started = await startBrowserControlServerFromConfig();

    expect(started).toBeNull();
    expect(mocks.ensureExtensionRelayForProfiles).not.toHaveBeenCalled();
  });

  it("still requires browser auth when trusted-proxy mode has a password SecretRef", async () => {
    mocks.gatewayAuthMode = "trusted-proxy";
    mocks.gatewayAuthPassword = { source: "env", provider: "default", id: "BROWSER_PASSWORD" };
    mocks.gatewayTrustedProxyUserHeader = "x-forwarded-user";
    mocks.ensureBrowserControlAuth.mockResolvedValueOnce({ auth: {} });
    mocks.resolveBrowserControlAuth.mockReturnValueOnce({});
    mocks.shouldAutoGenerateBrowserAuth.mockReturnValueOnce(true);

    const started = await startBrowserControlServerFromConfig();

    expect(started).toBeNull();
    expect(mocks.ensureExtensionRelayForProfiles).not.toHaveBeenCalled();
  });

  it("uses the latest auth config after browser auth ensure", async () => {
    mocks.gatewayAuthMode = "trusted-proxy";
    mocks.gatewayTrustedProxyUserHeader = "x-forwarded-user";
    mocks.ensureBrowserControlAuth.mockImplementationOnce(async () => {
      mocks.gatewayAuthPassword = { source: "env", provider: "default", id: "BROWSER_PASSWORD" };
      return { auth: {} };
    });
    mocks.resolveBrowserControlAuth.mockReturnValueOnce({});
    mocks.shouldAutoGenerateBrowserAuth.mockReturnValueOnce(true);

    const started = await startBrowserControlServerFromConfig();

    expect(started).toBeNull();
    expect(mocks.ensureExtensionRelayForProfiles).not.toHaveBeenCalled();
  });
});
