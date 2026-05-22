import type { ImageContent } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { mimeTypeFromFilePath } from "../../media/mime.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { MsgContext } from "../templating.js";
import { loadDispatchAcpMediaRuntime } from "./dispatch-acp-attachments.js";

const CURRENT_TURN_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const CURRENT_TURN_IMAGE_TIMEOUT_MS = 1_000;

function isGenericMediaType(mediaType: string | undefined): boolean {
  if (!mediaType) {
    return true;
  }
  const normalized = mediaType.split(";")[0]?.trim().toLowerCase();
  return normalized === "application/octet-stream" || normalized === "binary/octet-stream";
}

function resolveCurrentImageMediaType(pathValue: unknown, mediaType?: unknown): string | undefined {
  const mediaPath = normalizeOptionalString(pathValue);
  if (!mediaPath) {
    return undefined;
  }
  const normalizedMediaType = normalizeOptionalString(mediaType);
  if (normalizedMediaType?.startsWith("image/")) {
    return normalizedMediaType;
  }
  if (!isGenericMediaType(normalizedMediaType)) {
    return undefined;
  }
  const inferredType = mimeTypeFromFilePath(mediaPath);
  return inferredType?.startsWith("image/") ? inferredType : undefined;
}

function resolveCurrentImageContext(ctx: MsgContext): {
  ctx: MsgContext;
  imageCount: number;
} {
  const pathsFromArray = Array.isArray(ctx.MediaPaths) ? ctx.MediaPaths : undefined;
  const paths =
    pathsFromArray && pathsFromArray.length > 0
      ? pathsFromArray
      : normalizeOptionalString(ctx.MediaPath)
        ? [ctx.MediaPath]
        : [];
  if (paths.length === 0) {
    return { ctx, imageCount: 0 };
  }

  const types =
    Array.isArray(ctx.MediaTypes) && ctx.MediaTypes.length === paths.length
      ? ctx.MediaTypes
      : undefined;
  const mediaTypes = paths.map((pathValue, index) =>
    resolveCurrentImageMediaType(pathValue, types?.[index] ?? ctx.MediaType),
  );
  const imageCount = mediaTypes.filter(Boolean).length;
  if (imageCount === 0) {
    return { ctx, imageCount: 0 };
  }

  const nextCtx = { ...ctx };
  if (pathsFromArray && pathsFromArray.length > 0) {
    nextCtx.MediaTypes = mediaTypes.map(
      (type, index) => type ?? types?.[index] ?? ctx.MediaType ?? "application/octet-stream",
    );
    nextCtx.MediaType = mediaTypes[0] ?? ctx.MediaType;
  } else {
    nextCtx.MediaType = mediaTypes[0] ?? ctx.MediaType;
  }
  return { ctx: nextCtx, imageCount };
}

export async function resolveCurrentTurnImages(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
}): Promise<{
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
}> {
  if (Array.isArray(params.images) && params.images.length > 0) {
    return { images: params.images, imageOrder: params.imageOrder };
  }

  const currentImageContext = resolveCurrentImageContext(params.ctx);
  const currentImageCandidateCount = currentImageContext.imageCount;
  if (currentImageCandidateCount === 0) {
    return { images: params.images, imageOrder: params.imageOrder };
  }

  try {
    const runtime = await loadDispatchAcpMediaRuntime();
    const mediaAttachments = runtime
      .normalizeAttachments(currentImageContext.ctx)
      .map((attachment) =>
        normalizeOptionalString(attachment.path)
          ? Object.assign({}, attachment, { url: undefined })
          : attachment,
      );
    const cache = new runtime.MediaAttachmentCache(mediaAttachments, {
      localPathRoots: runtime.resolveMediaAttachmentLocalRoots({
        cfg: params.cfg,
        ctx: currentImageContext.ctx,
      }),
      workspaceDir: currentImageContext.ctx.MediaWorkspaceDir,
    });
    const images: ImageContent[] = [];
    for (const attachment of mediaAttachments) {
      const mediaType = attachment.mime ?? "application/octet-stream";
      if (!mediaType.startsWith("image/") || !normalizeOptionalString(attachment.path)) {
        continue;
      }
      try {
        const { buffer } = await cache.getBuffer({
          attachmentIndex: attachment.index,
          maxBytes: CURRENT_TURN_IMAGE_MAX_BYTES,
          timeoutMs: CURRENT_TURN_IMAGE_TIMEOUT_MS,
        });
        images.push({
          type: "image",
          data: buffer.toString("base64"),
          mimeType: mediaType,
        });
      } catch (error) {
        if (runtime.isMediaUnderstandingSkipError(error)) {
          logVerbose(
            `agent-runner: skipping current image attachment #${attachment.index + 1} (${error.reason})`,
          );
        } else {
          logVerbose(
            `agent-runner: failed to read current image attachment #${attachment.index + 1}: ${formatErrorMessage(error)}`,
          );
        }
      }
    }
    if (images.length < currentImageCandidateCount) {
      logVerbose(
        `agent-runner: native PI media resolution produced ${images.length}/${currentImageCandidateCount} current image attachment(s); falling back to prompt image refs`,
      );
      return { images: params.images, imageOrder: params.imageOrder };
    }
    return images.length > 0
      ? { images, imageOrder: images.map(() => "inline" as const) }
      : { images: params.images, imageOrder: params.imageOrder };
  } catch (error) {
    logVerbose(
      `agent-runner: media attachment image resolution failed, proceeding without native images: ${formatErrorMessage(error)}`,
    );
    return { images: params.images, imageOrder: params.imageOrder };
  }
}
