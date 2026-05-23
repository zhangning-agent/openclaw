import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getProviderEnvVars } from "../../secrets/provider-env-vars.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { isCapabilityProviderConfigured } from "./media-tool-shared.js";

type MediaGenerateActionResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

type TaskStatusTextBuilder<Task> = (task: Task, params?: { duplicateGuard?: boolean }) => string;
type MediaGenerateProvider = {
  id: string;
  aliases?: string[];
  defaultModel?: string;
  models?: string[];
  capabilities: unknown;
  isConfigured?: (ctx: { cfg?: OpenClawConfig; agentDir?: string }) => boolean;
};

export type { MediaGenerateActionResult };

export function createMediaGenerateProviderListActionResult<
  TProvider extends MediaGenerateProvider,
>(params: {
  providers: TProvider[];
  emptyText: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
  listModes: (provider: TProvider) => string[];
  summarizeCapabilities: (provider: TProvider) => string;
}): MediaGenerateActionResult {
  if (params.providers.length === 0) {
    return {
      content: [{ type: "text", text: params.emptyText }],
      details: { providers: [] },
    };
  }

  const providers = params.providers.map((provider) => ({
    id: provider.id,
    defaultModel: provider.defaultModel,
    models: provider.models ?? [],
    modes: params.listModes(provider),
    configured: isCapabilityProviderConfigured({
      providers: params.providers,
      provider,
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      authStore: params.authStore,
    }),
    authEnvVars: getProviderEnvVars(provider.id),
    capabilities: provider.capabilities,
  }));

  const lines = providers.map((provider, index) => {
    const sourceProvider = params.providers[index];
    const authHints = getProviderEnvVars(provider.id);
    const capabilities = params.summarizeCapabilities(sourceProvider);
    return [
      `${provider.id}: default=${provider.defaultModel ?? "none"}`,
      provider.models?.length ? `models=${provider.models.join(", ")}` : null,
      `configured=${provider.configured ? "yes" : "no"}`,
      capabilities ? `capabilities=${capabilities}` : null,
      authHints.length > 0 ? `auth=${authHints.join(" / ")}` : null,
    ]
      .filter((entry): entry is string => Boolean(entry))
      .join(" | ");
  });

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      providers,
    },
  };
}

export function createMediaGenerateTaskStatusActions<Task>(params: {
  inactiveText: string;
  findActiveTask: (sessionKey?: string) => Task | undefined;
  buildStatusText: TaskStatusTextBuilder<Task>;
  buildStatusDetails: (task: Task) => Record<string, unknown>;
}) {
  return {
    createStatusActionResult(sessionKey?: string): MediaGenerateActionResult {
      return createMediaGenerateStatusActionResult({
        sessionKey,
        inactiveText: params.inactiveText,
        findActiveTask: params.findActiveTask,
        buildStatusText: params.buildStatusText,
        buildStatusDetails: params.buildStatusDetails,
      });
    },

    createDuplicateGuardResult(sessionKey?: string): MediaGenerateActionResult | undefined {
      return createMediaGenerateDuplicateGuardResult({
        sessionKey,
        findActiveTask: params.findActiveTask,
        buildStatusText: params.buildStatusText,
        buildStatusDetails: params.buildStatusDetails,
      });
    },
  };
}

function createMediaGenerateStatusActionResult<Task>(params: {
  sessionKey?: string;
  inactiveText: string;
  findActiveTask: (sessionKey?: string) => Task | undefined;
  buildStatusText: TaskStatusTextBuilder<Task>;
  buildStatusDetails: (task: Task) => Record<string, unknown>;
}): MediaGenerateActionResult {
  const activeTask = params.findActiveTask(params.sessionKey);
  if (!activeTask) {
    return {
      content: [{ type: "text", text: params.inactiveText }],
      details: {
        action: "status",
        active: false,
      },
    };
  }
  return {
    content: [{ type: "text", text: params.buildStatusText(activeTask) }],
    details: {
      action: "status",
      ...params.buildStatusDetails(activeTask),
    },
  };
}

function createMediaGenerateDuplicateGuardResult<Task>(params: {
  sessionKey?: string;
  findActiveTask: (sessionKey?: string) => Task | undefined;
  buildStatusText: TaskStatusTextBuilder<Task>;
  buildStatusDetails: (task: Task) => Record<string, unknown>;
}): MediaGenerateActionResult | undefined {
  const activeTask = params.findActiveTask(params.sessionKey);
  if (!activeTask) {
    return undefined;
  }
  return {
    content: [
      {
        type: "text",
        text: params.buildStatusText(activeTask, { duplicateGuard: true }),
      },
    ],
    details: {
      action: "status",
      duplicateGuard: true,
      ...params.buildStatusDetails(activeTask),
    },
  };
}
