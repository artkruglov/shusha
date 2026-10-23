/**
 * Mini App API channel: the board and its tasks, «Группы» (behind a flag), and the «Ещё» screens (settings, memory, routines,
 * shopping), outside Eve's session API.
 *
 * Export:
 * - Default Eve custom channel with the `/app-api/*` routes; logic in `lib/web-app/web-app-api.ts`.
 */
import { defineChannel, GET, POST } from "eve/channels";

import { WEB_APP_API_PREFIX, webAppApi } from "../lib/web-app/web-app-api.js";
import { webAppFamilyApi as family } from "../lib/web-app/web-app-family-api.js";
import { webAppGroupsApi as groups } from "../lib/web-app/web-app-groups-api.js";
import { webAppMoreApi as more } from "../lib/web-app/web-app-more-api.js";
import { webAppProjectsApi as projects } from "../lib/web-app/web-app-projects.js";
import { webAppVoiceApi as voice } from "../lib/web-app/web-app-voice.js";
import { webAppStaleApi as stale } from "../lib/web-app/web-app-stale-api.js";

export default defineChannel({
  routes: [
    GET(`${WEB_APP_API_PREFIX}/board`, (request) => webAppApi.board(request)),
    GET(`${WEB_APP_API_PREFIX}/closed`, (request) => webAppApi.closed(request)),
    POST(`${WEB_APP_API_PREFIX}/tasks`, (request) => webAppApi.create(request)),
    GET(`${WEB_APP_API_PREFIX}/participants`, (request) => webAppApi.participants(request)),
    GET(`${WEB_APP_API_PREFIX}/tasks/:id`, (request, { params }) => webAppApi.card(request, params)),
    POST(`${WEB_APP_API_PREFIX}/tasks/:id/:action`, (request, { params }) => webAppApi.task(request, params)),
    GET(`${WEB_APP_API_PREFIX}/stale`, (request) => stale.list(request)),
    POST(`${WEB_APP_API_PREFIX}/stale/:id/:action`, (request, { params }) => stale.answer(request, params)),
    GET(`${WEB_APP_API_PREFIX}/projects`, (request) => projects.list(request)),
    POST(`${WEB_APP_API_PREFIX}/projects`, (request) => projects.create(request)),
    GET(`${WEB_APP_API_PREFIX}/projects/:id`, (request, { params }) => projects.detail(request, params)),
    POST(`${WEB_APP_API_PREFIX}/projects/:id/:action`, (request, { params }) => projects.change(request, params)),
    GET(`${WEB_APP_API_PREFIX}/family`, (request) => family.read(request)),
    POST(`${WEB_APP_API_PREFIX}/family/traditions/:id/done`, (request, { params }) => family.tradition(request, params)),
    POST(`${WEB_APP_API_PREFIX}/family/areas/:id/:action`, (request, { params }) => family.area(request, params)),
    POST(`${WEB_APP_API_PREFIX}/family/decisions/:id/answer`, (request, { params }) => family.answer(request, params)),
    POST(`${WEB_APP_API_PREFIX}/family/time`, (request) => family.addTime(request)),
    POST(`${WEB_APP_API_PREFIX}/family/time/:id/remove`, (request, { params }) => family.removeTime(request, params)),
    GET(`${WEB_APP_API_PREFIX}/groups`, (request) => groups.list(request)),
    GET(`${WEB_APP_API_PREFIX}/groups/:id`, (request, { params }) => groups.detail(request, params)),
    POST(`${WEB_APP_API_PREFIX}/groups/:id/tasks`, (request, { params }) => groups.create(request, params)),
    POST(`${WEB_APP_API_PREFIX}/groups/:id/invite`, (request, { params }) => groups.invite(request, params)),
    POST(`${WEB_APP_API_PREFIX}/groups/:id/tasks/:task/:action`, (request, { params }) => groups.task(request, params)),
    GET(`${WEB_APP_API_PREFIX}/settings`, (request) => more.settings(request)),
    POST(`${WEB_APP_API_PREFIX}/settings`, (request) => more.saveSettings(request)),
    GET(`${WEB_APP_API_PREFIX}/memory`, (request) => more.memory(request)),
    GET(`${WEB_APP_API_PREFIX}/memory/:ref/source`, (request, { params }) => more.memorySource(request, params)),
    POST(`${WEB_APP_API_PREFIX}/memory/:ref/forget`, (request, { params }) => more.forget(request, params)),
    GET(`${WEB_APP_API_PREFIX}/routines`, (request) => more.routines(request)),
    POST(`${WEB_APP_API_PREFIX}/routines/:kind/:id/:action`, (request, { params }) => more.routine(request, params)),
    GET(`${WEB_APP_API_PREFIX}/capabilities`, (request) => more.capabilities(request)),
    GET(`${WEB_APP_API_PREFIX}/home`, (request) => more.home(request)),
    POST(`${WEB_APP_API_PREFIX}/quest/try`, (request) => more.questTry(request)),
    POST(`${WEB_APP_API_PREFIX}/quest/hide`, (request) => more.questHide(request)),
    POST(`${WEB_APP_API_PREFIX}/studio`, (request) => more.studioStart(request)),
    POST(`${WEB_APP_API_PREFIX}/studio/upload`, (request) => more.uploadPhoto(request)),
    GET(`${WEB_APP_API_PREFIX}/studio/:nonce`, (request, { params }) => more.studioState(request, params)),
    GET(`${WEB_APP_API_PREFIX}/files`, (request) => more.files(request)),
    GET(`${WEB_APP_API_PREFIX}/files/preview`, (request) => more.filePreview(request)),
    POST(`${WEB_APP_API_PREFIX}/files/send`, (request) => more.sendFile(request)),
    POST(`${WEB_APP_API_PREFIX}/hint`, (request) => more.hint(request)),
    POST(`${WEB_APP_API_PREFIX}/voice`, (request) => voice.transcribe(request)),
    GET(`${WEB_APP_API_PREFIX}/shopping`, (request) => more.shopping(request)),
    POST(`${WEB_APP_API_PREFIX}/shopping`, (request) => more.addShopping(request)),
    POST(`${WEB_APP_API_PREFIX}/shopping/:id/:action`, (request, { params }) => more.changeShopping(request, params)),
  ],
});
