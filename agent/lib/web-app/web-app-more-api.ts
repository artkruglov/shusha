/**
 * Маршруты раздела «Ещё» Mini App: утренняя сводка, память, напоминания и регулярное, покупки, а также
 * флаги каталога «Умеет», подсказка в чат и «Мои картинки и файлы».
 *
 * Exports:
 * - `WebAppMoreDependencies`, `createWebAppMoreApi`: обработчики с подменяемыми зависимостями, для тестов.
 * - `webAppMoreDependencies`, `webAppMoreApi`: то же на базе приложения.
 *
 * Тот же путь запроса, что у доски (`web-app-api.ts`): человек только из подписи `initData`, права лички,
 * работа внутри семьи (`withFamilyDatabaseContext`). Каждое изменение несёт `nonce`, ключ операции
 * `webapp:<user>:<nonce>` делает повтор нажатия повтором, а не вторым изменением, там, где репозиторий ведёт
 * журнал операций. В теле только id, действие и значения; что разрешено, решают репозитории.
 */
import { AppError } from "../app-error.js";
import { currentTimeRepository } from "../current-time-repository.js";
import { withFamilyDatabaseContext } from "../database-context.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { MEMORY_REF_PATTERN } from "../model-memory.js";
import { memoryReviewOwnerAlertTransport } from "../memory-review/memory-review-owner-alert-transport.js";
import { shoppingRepository } from "../shopping/shopping-repository.js";
import {
  authorizeWebApp, readWebAppJson, webAppApiDependencies, webAppBadRequest, webAppFailure, webAppJson,
  type WebAppApiDependencies,
} from "./web-app-api.js";
import {
  createHintThrottle, WEB_APP_HINTS, webAppCapabilities, type HintThrottle, type WebAppCapabilities,
} from "./web-app-hints.js";
import { webAppFiles, type WebAppFile, type WebAppFileSend } from "./web-app-files.js";
import { webAppHome, type WebAppHome } from "./web-app-home.js";
import { webAppQuest } from "./web-app-quest.js";
import { webAppStudio, type StudioState } from "./web-app-studio.js";
import { PHOTO_UPLOAD_MAX_BYTES, readLimitedBody, webAppPhotoUpload } from "./web-app-photo-upload.js";
import { webAppMemory, type WebAppMemoryPage, type WebAppMemorySource } from "./web-app-memory.js";
import { webAppRoutines, type WebAppRoutine, type WebAppRoutines } from "./web-app-routines.js";
import { parseSettingsChange, webAppSettings, type WebAppSettings, type WebAppSettingsChange } from "./web-app-settings.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CURSOR_MAX = 300;
const SHOPPING_TITLE_MAX = 200;
/** Items one line may add at once. */
const SHOPPING_LINE_MAX = 20;
const ROUTINE_ACTIONS = ["enable", "disable", "delete", "run"] as const;
const SHOPPING_ACTIONS = ["buy", "unbuy", "remove"] as const;

export interface WebAppShoppingItem {
  id: string;
  listName: string;
  title: string;
  quantity: string | null;
  addedBy: string | null;
  bought: boolean;
  version: number;
}

export interface WebAppMoreDependencies extends Pick<WebAppApiDependencies, "botToken" | "findIdentity" | "now" | "turnSpace"> {
  settings(auth: MemoryAuthorization): Promise<WebAppSettings>;
  saveSettings(auth: MemoryAuthorization, change: WebAppSettingsChange): Promise<WebAppSettings>;
  memory(auth: MemoryAuthorization, cursor: string | undefined): Promise<WebAppMemoryPage>;
  memorySource(auth: MemoryAuthorization, ref: string): Promise<WebAppMemorySource>;
  forget(auth: MemoryAuthorization, ref: string, operationKey: string): Promise<void>;
  routines(auth: MemoryAuthorization, now: Date): Promise<WebAppRoutines>;
  routine(auth: MemoryAuthorization, kind: WebAppRoutine["kind"], id: string,
    action: typeof ROUTINE_ACTIONS[number], operationKey: string): Promise<void>;
  shopping(auth: MemoryAuthorization): Promise<WebAppShoppingItem[]>;
  shop(auth: MemoryAuthorization, input: { action: "add"; title: string } | {
    action: typeof SHOPPING_ACTIONS[number]; id: string; version: number;
  }, operationKey: string): Promise<void>;
  capabilities(): WebAppCapabilities;
  home(auth: MemoryAuthorization, now: Date): Promise<WebAppHome>;
  questTry(auth: MemoryAuthorization, step: number, now: Date): Promise<{ ok: true }>;
  questHide(auth: MemoryAuthorization, now: Date): Promise<{ ok: true }>;
  studioStart(auth: MemoryAuthorization, input: { note?: string; recipe: string; source?: { path: string; scope: string } }, nonce: string): Promise<StudioState>;
  studioState(auth: MemoryAuthorization, nonce: string): Promise<StudioState>;
  uploadPhoto(auth: MemoryAuthorization, bytes: Uint8Array, nonce: string, now: Date): Promise<{ path: string; scope: "personal" }>;
  files(auth: MemoryAuthorization): Promise<WebAppFile[]>;
  filePreview(auth: MemoryAuthorization, scope: string, path: string): Promise<{ bytes: Uint8Array; mediaType: string }>;
  sendFile(auth: MemoryAuthorization, input: { path: string; purpose: WebAppFileSend; scope: string }, operationKey: string): Promise<void>;
  /** The private chat's message; the chat of a private conversation is the person. */
  sendHint(input: { chatId: string; text: string }): Promise<void>;
  hintThrottle: HintThrottle;
}

export function createWebAppMoreApi(dependencies: WebAppMoreDependencies) {
  /** One request: the person, then the work inside their family's row scope. */
  function handle(work: (auth: MemoryAuthorization, request: Request) => Promise<unknown>) {
    return async (request: Request): Promise<Response> => {
      try {
        const auth = await authorizeWebApp(request, dependencies);
        return webAppJson(200, await withFamilyDatabaseContext(auth.familyId, () => work(auth, request)));
      } catch (error) {
        return webAppFailure(error);
      }
    };
  }
  const key = (auth: MemoryAuthorization, nonce: string) => `webapp:${auth.userId}:${nonce}`;

  return {
    settings: handle((auth) => dependencies.settings(auth)),
    saveSettings: handle(async (auth, request) => {
      const body = await readWebAppJson(request);
      return dependencies.saveSettings(auth, parseSettingsChange(body));
    }),
    memory: handle((auth, request) => {
      const cursor = new URL(request.url).searchParams.get("cursor") ?? undefined;
      if (cursor !== undefined && (cursor.length === 0 || cursor.length > CURSOR_MAX)) webAppBadRequest();
      return dependencies.memory(auth, cursor);
    }),
    memorySource: (request: Request, params: Readonly<Record<string, string>>) => handle((auth) => {
      if (!MEMORY_REF_PATTERN.test(params.ref ?? "")) webAppBadRequest();
      return dependencies.memorySource(auth, params.ref!);
    })(request),
    forget: (request: Request, params: Readonly<Record<string, string>>) => handle(async (auth, body) => {
      if (!MEMORY_REF_PATTERN.test(params.ref ?? "")) webAppBadRequest();
      const { nonce } = await readWebAppJson(body);
      await dependencies.forget(auth, params.ref!, key(auth, nonce));
      console.info(JSON.stringify({ code: "AGENT_WEB_APP_MEMORY_FORGOTTEN" }));
      return { ok: true };
    })(request),
    routines: handle((auth) => dependencies.routines(auth, dependencies.now())),
    routine: (request: Request, params: Readonly<Record<string, string>>) => handle(async (auth, body) => {
      const { action, id, kind } = params;
      if (kind !== "reminder" && kind !== "schedule") webAppBadRequest();
      if (!UUID.test(id ?? "") || !(ROUTINE_ACTIONS as readonly string[]).includes(action ?? "")) webAppBadRequest();
      if (action === "run" && kind !== "schedule") webAppBadRequest();
      const { nonce } = await readWebAppJson(body);
      await dependencies.routine(auth, kind, id!, action as typeof ROUTINE_ACTIONS[number], key(auth, nonce));
      console.info(JSON.stringify({ action, code: "AGENT_WEB_APP_ROUTINE_CHANGED", kind }));
      return dependencies.routines(auth, dependencies.now());
    })(request),
    capabilities: handle(async () => dependencies.capabilities()),
    home: handle(async (auth) => dependencies.home(auth, dependencies.now())),
    questTry: handle(async (auth, request) => {
      const { step } = await readWebAppJson(request);
      if (typeof step !== "number" || !Number.isInteger(step) || step < 1 || step > 99) webAppBadRequest();
      return dependencies.questTry(auth, step, dependencies.now());
    }),
    questHide: handle(async (auth) => dependencies.questHide(auth, dependencies.now())),
    studioStart: handle(async (auth, request) => {
      const { nonce, note, recipe, source } = await readWebAppJson(request);
      if (typeof recipe !== "string" || (note !== undefined && typeof note !== "string")) webAppBadRequest();
      const picked = source as { path?: unknown; scope?: unknown } | undefined;
      if (picked !== undefined && (typeof picked !== "object" || picked === null || typeof picked.path !== "string" || typeof picked.scope !== "string")) {
        webAppBadRequest();
      }
      return dependencies.studioStart(auth, {
        recipe, ...(note === undefined ? {} : { note: note as string }),
        ...(picked === undefined ? {} : { source: { path: picked.path as string, scope: picked.scope as string } }),
      }, nonce);
    }),
    /** Raw image bytes in the body; the nonce in the query, since the body is not JSON. */
    uploadPhoto: handle(async (auth, request) => {
      const nonce = new URL(request.url).searchParams.get("nonce") ?? "";
      if (!/^[A-Za-z0-9-]{8,64}$/u.test(nonce)) webAppBadRequest();
      const declared = Number(request.headers.get("content-length") ?? "0");
      if (declared > PHOTO_UPLOAD_MAX_BYTES) webAppBadRequest();
      // Counted while read: a chunked body without a length stops right past the limit.
      const bytes = await readLimitedBody(request, PHOTO_UPLOAD_MAX_BYTES);
      return dependencies.uploadPhoto(auth, bytes, nonce, dependencies.now());
    }),
    studioState: (request: Request, params: Readonly<Record<string, string>>) => handle(async (auth) => {
      if (!/^[A-Za-z0-9-]{8,64}$/u.test(params.nonce ?? "")) webAppBadRequest();
      return dependencies.studioState(auth, params.nonce!);
    })(request),
    files: handle(async (auth) => ({ files: await dependencies.files(auth) })),
    /** Bytes, not JSON: the page fetches them with its signature and shows them as a `blob:` picture. */
    async filePreview(request: Request): Promise<Response> {
      try {
        const auth = await authorizeWebApp(request, dependencies);
        const url = new URL(request.url);
        const scope = url.searchParams.get("scope") ?? "";
        const path = url.searchParams.get("path") ?? "";
        const preview = await withFamilyDatabaseContext(auth.familyId, () => dependencies.filePreview(auth, scope, path));
        return new Response(new Uint8Array(preview.bytes), { headers: {
          "cache-control": "private, max-age=3600", "content-type": preview.mediaType, "x-content-type-options": "nosniff",
        } });
      } catch (error) {
        return webAppFailure(error);
      }
    },
    sendFile: handle(async (auth, request) => {
      const { nonce, path, purpose, scope } = await readWebAppJson(request);
      if (typeof path !== "string" || typeof scope !== "string") webAppBadRequest();
      if (purpose !== "send" && purpose !== "variant" && purpose !== "animate") webAppBadRequest();
      await dependencies.sendFile(auth, { path, purpose, scope }, key(auth, nonce));
      console.info(JSON.stringify({ code: "AGENT_WEB_APP_FILE_SENT", purpose }));
      return { ok: true };
    }),
    hint: handle(async (auth, request) => {
      const { id } = await readWebAppJson(request);
      if (typeof id !== "string" || !Object.hasOwn(WEB_APP_HINTS, id)) webAppBadRequest();
      if (!dependencies.hintThrottle.take(auth.userId!, dependencies.now())) {
        throw new AppError("AGENT_WEB_APP_HINT_LIMITED", "Подсказка уже в чате. Загляните туда");
      }
      await dependencies.sendHint({ chatId: auth.telegramUserId!, text: WEB_APP_HINTS[id]! });
      console.info(JSON.stringify({ code: "AGENT_WEB_APP_HINT_SENT", hint: id }));
      return { ok: true };
    }),
    shopping: handle(async (auth) => ({ items: await dependencies.shopping(auth) })),
    addShopping: handle(async (auth, request) => {
      const { nonce, title } = await readWebAppJson(request);
      if (typeof title !== "string") webAppBadRequest();
      // «молоко, хлеб, яйца» is three items, as people write a list; each has its own operation key, so a retry
      // of the whole line adds none twice. One item keeps the key it always had.
      const titles = title.split(/[,;\n]+/u).map((part) => part.trim()).filter((part) => part.length > 0);
      if (titles.length === 0 || titles.length > SHOPPING_LINE_MAX
        || titles.some((part) => Array.from(part).length > SHOPPING_TITLE_MAX)) webAppBadRequest();
      for (const [index, item] of titles.entries()) {
        await dependencies.shop(auth, { action: "add", title: item }, index === 0 ? key(auth, nonce) : `${key(auth, nonce)}:${index}`);
      }
      return { items: await dependencies.shopping(auth) };
    }),
    changeShopping: (request: Request, params: Readonly<Record<string, string>>) => handle(async (auth, body) => {
      const { action, id } = params;
      if (!UUID.test(id ?? "") || !(SHOPPING_ACTIONS as readonly string[]).includes(action ?? "")) webAppBadRequest();
      const { nonce, version } = await readWebAppJson(body);
      if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) webAppBadRequest();
      await dependencies.shop(auth, { action: action as typeof SHOPPING_ACTIONS[number], id: id!, version }, key(auth, nonce));
      return { items: await dependencies.shopping(auth) };
    })(request),
  };
}

/** The shopping list the chat calls «Продукты» and any other list of the person's family area. */
async function shoppingItems(auth: MemoryAuthorization): Promise<WebAppShoppingItem[]> {
  const result = await shoppingRepository.execute(auth, { action: "list", view: "all" }, "webapp-read") as {
    items?: Array<{
      addedBy: string | null; boughtAt: string | null; id: string; listName: string; quantity: string | null; title: string;
      version: number;
    }>;
  };
  if (!result.items) throw new AppError("AGENT_WEB_APP_FAILED", "Список покупок не прочитался");
  return result.items.map((item) => ({
    addedBy: item.addedBy, bought: item.boughtAt !== null, id: item.id, listName: item.listName, quantity: item.quantity,
    title: item.title,
    version: item.version,
  }));
}

export const webAppMoreDependencies: WebAppMoreDependencies = {
  botToken: webAppApiDependencies.botToken,
  capabilities: webAppCapabilities,
  studioStart: (auth, input, nonce) => webAppStudio.start(auth, input, nonce),
  studioState: (auth, nonce) => webAppStudio.state(auth, nonce),
  uploadPhoto: (auth, bytes, nonce, now) => webAppPhotoUpload.save(auth, bytes, nonce, now),
  async home(auth, now) {
    const timezone = await currentTimeRepository.findTurnTimezone(auth.userId!, auth.familyId) ?? "UTC";
    const [home, quest] = await Promise.all([webAppHome.read(auth, timezone, now), webAppQuest.read(auth, now)]);
    return { ...home, quest };
  },
  questTry: (auth, step, now) => webAppQuest.tryStep(auth, step, now),
  questHide: (auth, now) => webAppQuest.hide(auth, now),
  filePreview: (auth, scope, path) => webAppFiles.preview(auth, scope, path),
  files: (auth) => webAppFiles.list(auth),
  sendFile: (auth, input, operationKey) => webAppFiles.send(auth, input, operationKey),
  findIdentity: webAppApiDependencies.findIdentity,
  hintThrottle: createHintThrottle(),
  forget: (auth, ref, operationKey) => webAppMemory.remove(auth, ref, operationKey),
  memory: (auth, cursor) => webAppMemory.list(auth, cursor),
  memorySource: (auth, ref) => webAppMemory.source(auth, ref),
  now: webAppApiDependencies.now,
  async routine(auth, kind, id, action, operationKey) {
    if (action === "run") return webAppRoutines.runNow(auth, id, operationKey);
    if (action === "delete") return webAppRoutines.remove(auth, kind, id, operationKey);
    return webAppRoutines.setEnabled(auth, kind, id, action === "enable", operationKey);
  },
  routines: (auth, now) => webAppRoutines.list(auth, now),
  saveSettings: (auth, change) => webAppSettings.save(auth, change),
  sendHint: (input) => memoryReviewOwnerAlertTransport.deliver(input),
  settings: (auth) => webAppSettings.read(auth),
  async shop(auth, input, operationKey) {
    // A new item goes to «Продукты», the list the chat adds to when no list is named.
    const raw = input.action === "add" ? { action: "add" as const, listName: "Продукты", title: input.title } : input;
    await shoppingRepository.execute(auth, raw, operationKey);
  },
  shopping: shoppingItems,
  turnSpace: webAppApiDependencies.turnSpace,
};

export const webAppMoreApi = createWebAppMoreApi(webAppMoreDependencies);
