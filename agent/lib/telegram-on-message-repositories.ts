/**
 * Telegram inbound handler dependency contract and production adapters.
 *
 * Exports:
 * - `TelegramMessageRepositories`: explicit repository surface consumed by authorization handling.
 * - `productionTelegramMessageRepositories`: PostgreSQL, attachment, notice, and workspace adapters.
 */
import { buildTaskProjectsContext } from "./projects/project-context.js";
import type { TelegramMessage } from "eve/channels/telegram";

import { downloadTelegramAttachment } from "./attachments/telegram-attachment-download.js";
import {
  telegramGroupAttachmentRepository,
  type TelegramGroupAttachmentRepository,
} from "./attachments/telegram-group-attachment-repository.js";
import {
  createTelegramWorkspaceAttachmentImporter,
  type StoredTelegramAttachment,
} from "./attachments/telegram-workspace-attachments.js";
import { conversationRepository } from "./conversation-repository.js";
import { resolveTelegramChatMode, resolveTurnSpace } from "./spaces/turn-space-selection.js";
import { conversationTimelineRepository } from "./conversation-timeline-repository.js";
import { currentTimeRepository } from "./current-time-repository.js";
import { initiativeRepository } from "./initiative/initiative-repository.js";
import { familyRepository, type FamilyRepository } from "./family-repository.js";
import { signupRepository } from "./signup-repository.js";
import { autoJoinFamilyGroupMember, registerFamilyGroupByCommand } from "./telegram-family-group-command.js";
import { familyBudgetRepository } from "./family-budget-repository.js";
import { WEB_APP_GROUPS_ENABLED } from "./groups-availability.js";
import { groupSetup } from "./group-join/group-setup.js";
import { registerGroupByCommand } from "./telegram-group-connect-command.js";
import { feedbackRepository, type FeedbackRepository } from "./telegram-feedback-command.js";
import { familylessGroupRepository } from "./familyless-group-repository.js";
import { runFamilylessGroupCommand } from "./telegram-familyless-group-command.js";
import { profileProjectionPolicyRepository } from "./profile-projection-policy-repository.js";
import { proactiveDeliveryRepository } from "./proactive-deliveries/proactive-delivery-repository.js";
import { prepareSessionHandoff, type SessionHandoffPreparer } from "./sessions/session-handoff.js";
import { sessionRepository } from "./sessions/session-repository.js";
import {
  telegramGroupJournalRepository,
  type TelegramGroupJournalRepository,
} from "./telegram-group-journal-repository.js";
import {
  telegramGroupTurnContextPreparer,
  type TelegramGroupTurnContextPreparer,
} from "./telegram-group-turn-context.js";
import {
  telegramHitlApprovalRepository,
  type TelegramHitlApprovalRepository,
} from "./telegram-hitl/approval-repository.js";
import {
  productionMemoryThreadNotices,
  type MemoryThreadNoticeDeliveryRepository,
} from "./telegram-memory-thread-notice.js";
import { telegramRepository, type TelegramRepository } from "./telegram-repository.js";
import { workspaceBinaryRepository } from "./workspaces/workspace-binary-repository.js";
import { inspectWorkspaceImage } from "./workspaces/workspace-image-inspection.js";
import type {
  WorkspaceAuthorization,
  WorkspaceScope,
} from "./workspaces/workspace-repository.js";
import { memoryReviewRepository } from "./memory-review/memory-review-repository.js";
import { buildTelegramMemoryContext } from "./telegram-turn-memory-context.js";
import { turnInterjectionRepository } from "./turn-interjection/turn-interjection-repository.js";

export interface TelegramMessageRepositories {
  attachmentReferences: Pick<TelegramGroupAttachmentRepository, "captureReplyTarget" | "record">;
  attachments: {
    inspect: typeof inspectWorkspaceImage;
    persist(input: {
      attachments: readonly TelegramMessage["attachments"][number][];
      auth: WorkspaceAuthorization;
      chatId: string;
      messageId: string;
      scope: WorkspaceScope;
    }): Promise<StoredTelegramAttachment[]>;
  };
  conversations: Pick<
    typeof conversationRepository,
    "getByChatId" | "getByGroupId" | "syncTimelineParticipants"
  >;
  currentTime: Pick<typeof currentTimeRepository, "findTurnTimezone">;
  /** Retrieved memory for the accepted turn, delivered as context rather than as instructions. */
  memoryContext: typeof buildTelegramMemoryContext;
  threadNotices: MemoryThreadNoticeDeliveryRepository;
  profilePolicies: Pick<
    typeof profileProjectionPolicyRepository,
    "claimPendingGroupNotice" | "markGroupNoticePresented"
  >;
  family: Pick<FamilyRepository, "claimInvitation">;
  /** Саморегистрация семьи по общей ссылке и команда оператора /signup. */
  signup: Pick<typeof signupRepository, "claimSelfServeFamily" | "isOperatorFamily" | "joinWaitlist" | "operatorTelegramUserId" | "releaseWaitlistNotice" | "status" | "takeWaitlistBatch" | "update">;
  /** `/family` в группе и автоподключение людей без семьи в группе, подключённой этой командой. */
  familyGroup: { autoJoin: typeof autoJoinFamilyGroupMember; command: typeof registerFamilyGroupByCommand };
  /** `/start@бот group` владельца («Группы», MVP-1); без флага `enabled` команда идёт прежним путём. */
  groupConnect: { command: typeof registerGroupByCommand; enabled: boolean; prepare?: typeof groupSetup.prepare };
  /** `/start` и `/stop` администратора в группе без семьи (миграции 175–176). */
  familylessGroup: {
    budgetGate: typeof familylessGroupRepository.budgetGate;
    command: typeof runFamilylessGroupCommand;
  };
  /** `/feedback` участника оператору, без модели (миграция 182). */
  feedback: FeedbackRepository;
  /** Месячный лимит расходов семьи на модель (миграция 181). */
  familyBudget: { budgetGate: typeof familyBudgetRepository.budgetGate };
  groupContext: { prepare: TelegramGroupTurnContextPreparer };
  hitl: Pick<TelegramHitlApprovalRepository, "authorizeReply">;
  /** Слово человека снимает паузу: пока он молчит, бот не начинает следующий разговор. */
  initiative: Pick<typeof initiativeRepository, "markAnswered">;
  journal: Pick<TelegramGroupJournalRepository, "findSeriesSequences" | "record">;
  memoryReview: Pick<
    typeof memoryReviewRepository,
    "failInteractivePreparation" | "observePassiveMessage" | "prepareInteractiveTurn"
  >;
  proactiveDeliveries: Pick<typeof proactiveDeliveryRepository, "listPendingContext">;
  /** Проекты области как справка в контексте хода; во внешней группе блока нет. */
  taskProjects: { contextBlock: typeof buildTaskProjectsContext };
  session: Pick<typeof sessionRepository, "hasRoute" | "prepareTurn">;
  /** Summarizes the session the turn limit retired for the one that replaces it. */
  sessionHandoff: { prepare: SessionHandoffPreparer };
  spaces: {
    resolveTelegramChatMode: typeof resolveTelegramChatMode;
    resolveTurnSpace: typeof resolveTurnSpace;
  };
  telegram: TelegramRepository;
  timeline: Pick<typeof conversationTimelineRepository, "recordInbound">;
  turnInterjections: Pick<typeof turnInterjectionRepository, "findDeliveredContentKind" | "findDeliveredContentKinds">;
}

// Production wiring stays separate from authorization flow so tests can replace every side effect.
export const productionTelegramMessageRepositories = {
  attachmentReferences: telegramGroupAttachmentRepository,
  attachments: { ...createTelegramWorkspaceAttachmentImporter({
    download: downloadTelegramAttachment,
    writeBinary: workspaceBinaryRepository.writeBinary,
  }), inspect: inspectWorkspaceImage },
  conversations: conversationRepository,
  currentTime: currentTimeRepository,
  memoryContext: buildTelegramMemoryContext,
  profilePolicies: profileProjectionPolicyRepository,
  family: familyRepository,
  signup: signupRepository,
  familyGroup: { autoJoin: autoJoinFamilyGroupMember, command: registerFamilyGroupByCommand },
  groupConnect: { command: registerGroupByCommand, enabled: WEB_APP_GROUPS_ENABLED, prepare: (input) => groupSetup.prepare(input) },
  familylessGroup: { budgetGate: familylessGroupRepository.budgetGate, command: runFamilylessGroupCommand },
  familyBudget: { budgetGate: familyBudgetRepository.budgetGate },
  feedback: feedbackRepository,
  groupContext: { prepare: telegramGroupTurnContextPreparer },
  hitl: telegramHitlApprovalRepository,
  initiative: initiativeRepository,
  journal: telegramGroupJournalRepository,
  memoryReview: memoryReviewRepository,
  proactiveDeliveries: proactiveDeliveryRepository,
  taskProjects: { contextBlock: buildTaskProjectsContext },
  session: sessionRepository,
  sessionHandoff: { prepare: (input) => prepareSessionHandoff(input) },
  spaces: { resolveTelegramChatMode, resolveTurnSpace },
  turnInterjections: turnInterjectionRepository,
  telegram: telegramRepository,
  timeline: conversationTimelineRepository,
  threadNotices: productionMemoryThreadNotices,
} satisfies TelegramMessageRepositories;
