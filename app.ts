import { quietDeliveryNotices } from "./lib/quiet-delivery-notices.ts";
import "./lib/i18n-preload.ts";
import { createTranslator as createTextTranslator } from "./packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { initializeI18n } from "./lib/i18n.ts";
import { panelI18n } from "./lib/i18n-settings.ts";
import { createGeneratedDeviceRefresh } from "./lib/generated-device-runtime.ts";
import { ensureManagedValkey } from "./lib/managed-valkey.ts";
import { builtinResourceDirectory } from "./lib/builtin-resources.ts";
import { isDirectInternalRequest, listenerOrigins } from "./lib/network-access.ts";
import { installTerminalLogging, formatTerminalLog } from "./lib/terminal-log-format.ts";
import { withDefaultUpdateSchedule } from "./lib/update-schedule-settings.ts";
import { createLegacyPanelRecoveryFlow, matchLegacyPanelRecoveryConfirmation, readLegacyPanelRecoveryEnabled } from "./lib/legacy-panel-recovery-flow.ts";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createProfileStore, gameCommandProfileId, ProfileError, withGameCommandProfiles } from "@lotus-yunzai/account";
import { sampleGachaCharacterReturns } from "@lotus-yunzai/gacha/character-returns";
import { calculateGachaPulls } from "@lotus-yunzai/gacha/expectation";
import { bbsCheckinForums, createProfileHoyoClient, isZzzGachaLinkMessage, type BbsCheckinForum } from "@lotus-yunzai/hoyo-client";
import { RedeemCodeService } from "@lotus-yunzai/hoyo-client/redeem-preview";
import { previewRedeemIdentity, submitPreviewCode } from "@lotus-yunzai/hoyo-client/redeem-submit";
import { nativeImageRasterScale, setImageRenderPreset, setImageFooter } from "@lotus-yunzai/skia";
import { renderDailyNoteReminderCard } from "@lotus-yunzai/skia/daily-note-reminder";
import { closeStorage, connectStorage, readStorageCommand, storage } from "@lotus-yunzai/storage";
import { accountCommands, isAccountLoginMutation, matchGameLoginRemoval, removeSelectedGameLogin } from "./lib/account-commands.ts";
import { accountCookieStatusFeatures, createAccountCookieStatus, matchesAccountCookieStatus } from "./lib/account-cookie-status.ts";
import { createGameProfileDefaults, gameProfileDefaultsPath } from "./lib/game-profile-defaults.ts";
import { createOwnRoleLegacyArtwork } from "./lib/own-role-legacy-artwork.ts";
import { matchOwnRoleSelection, ownRoleSelectionFeatures, selectOwnRole } from "./lib/own-role-selection.ts";
import { withGroupPersonalReplies } from "./lib/group-personal-replies.ts";
import { matchRetiredUidCommand, matchPublicUidQuery, createPublicUidQuery } from "./lib/uid-commands.ts";
import { createGameProfileCommands, matchGameProfileCommand } from "./lib/game-profile-commands.ts";
import { ownedPanelAuthorization } from "./lib/owned-panel-authorization.ts";
import { donationCommands } from "./lib/donation-command.ts";
import { characterGalleryCron, createCharacterGallerySchedule } from "./lib/character-gallery-schedule.ts";
import { legacyAnniversaryCommands } from "./lib/legacy-anniversary.ts";
import { weatherCommands } from "./lib/weather-command.ts";
import { legacyCharacterAliasCommands } from "./lib/legacy-character-alias-command.ts";
import { readGameCharacterAliases } from "./lib/game-character-aliases.ts";
import { chatFileRelaySource, readQqMessageMedia, readQqMessageSegmentMedia } from "./lib/chat-files.ts";
import { createImageOcr } from "./lib/image-ocr.ts";
import { createGroupAvatarCommand, groupAvatarNames } from "./lib/group-avatar-command.ts";
import { createOwnerAccountCommand, ownerAccountFeatureNames } from "./lib/owner-account-command.ts";
import { createOwnerQzoneCommand, ownerQzoneFeatures } from "./lib/owner-qzone-command.ts";
import { arkSelfRankFeatures, createArkSelfRankCommand, matchArkSelfRank } from "./lib/ark-self-rank.ts";
import { containsPanelSignatureChallenge, matchPanelSignatureCommand, panelSignatureFeatures } from "./lib/panel-signature.ts";
import { ownerContactListCommand, replyOwnerContactList } from "./lib/owner-contact-list.ts";
import { createOwnerMessageRelay, ownerRelayFeatureNames, type OwnerRelayAccount } from "./lib/owner-message-relay.ts";
import { groupCleanupCommands } from "./lib/group-cleanup-commands.ts";
import { groupMemberExportCommands } from "./lib/group-member-export-command.ts";
import { permissionCommands } from "./lib/permission-commands.ts";
import { createManualGroupLeave, manualGroupLeaveInput } from "./lib/manual-group-leave.ts";
import { qqAvatarCommand, qqAvatarReply } from "./lib/qq-avatar.ts";
import { isQqFaceCommand, qqFaceReply } from "./lib/qq-face.ts";
import { createChatMediaLinks } from "./lib/chat-media-links.ts";
import { createQuotedImageTools } from "./lib/quoted-image-tools.ts";
import { hostAccessListCommand, hostAccessListNames } from "./lib/host-access-list.ts";
import { cloudProfileCommands, cloudWalletProfile, createCloudGenshinWalletQuery, isCloudTokenInput } from "./lib/cloud-profile-commands.ts";
import { createCheckinAudit } from "./lib/checkin-audit.ts";
import { checkinAuditCommands } from "./lib/checkin-audit-commands.ts";
import { generalToolCommands } from "./lib/general-tools.ts";
import { notifyCheckin, type BotNotifications, type CheckinNotifyDelivery, type CheckinNotifyTransport } from "./lib/checkin-notify.ts";
import { checkinPlanCommands, checkinPlanNotice, checkinScheduleSettingCommands } from "./lib/checkin-plan-commands.ts";
import { checkinProfileCommands } from "./lib/checkin-profile-commands.ts";
import { checkinRosterCommands } from "./lib/checkin-roster-commands.ts";
import { checkinGroupRegistrationCommands } from "./lib/checkin-group-registration-commands.ts";
import { checkinBatchRetryCommands } from "./lib/checkin-batch-retry-commands.ts";
import { checkinBatchRefreshCommands } from "./lib/checkin-batch-refresh-commands.ts";
import { checkinRegistrationCommands, checkinStatus, checkinStatusCommand, checkinUnregistration, unregisterCheckinCommand } from "./lib/checkin-registration-commands.ts";
import { waitForCheckinNoticeTransport } from "./lib/checkin-notice-ready.ts";
import { createCheckinScheduleRuntime } from "./lib/checkin-schedule-runtime.ts";
import { createCheckinScheduleStore } from "./lib/checkin-schedule-store.ts";
import { checkinScheduleClock, type CheckinScheduleConfig } from "./lib/checkin-schedule-plan.ts";
import { gameCheckinCommands, namedCheckinCommand } from "./lib/game-checkin-commands.ts";
import { isPreviewRedeemSetting, redeemCodeCommands } from "./lib/redeem-code-commands.ts";
import { createManualRedeemCommand, isManualRedeemCommand } from "./lib/redeem-code-manual.ts";
import { createPreviewRedeemRunner } from "./lib/redeem-code-runner.ts";
import { readMilkySettings } from "./lib/adapters/milky-config.ts";
import { createMilkyGroupReviews } from "./lib/adapters/milky-group-reviews.ts";
import { createMilkyInvitationReceipts } from "./lib/adapters/milky-invitation-receipts.ts";
import { readFriendReplyParts } from "./lib/adapters/owner-friend-reply.ts";
import type { MilkySession, MilkyTransportOptions } from "./lib/adapters/milky-session.ts";
import { createMilkyWebhook } from "./lib/adapters/milky-webhook.ts";
import { createMilkyWs } from "./lib/adapters/milky-ws.ts";
import { startOneBot } from "./lib/adapters/onebot.ts";
import { OneBotGroups } from "./lib/adapters/onebot-groups.ts";
import { memberDisplayName } from "./lib/adapters/onebot-member-display.ts";
import { noticeGroupTransport, waitForMilkyNoticeReceipts, type NoticeGroupAccount } from "./lib/adapters/notice-groups.ts";
import { bindGroupVerificationSubject, groupModerationSession, isMemberMuteDuration, type GroupModerationResult, type MemberMuteNotice,
  type NativeGroupMessageSource, type NativeGroupOwnerAdminNotice, type NativeGroupOwnerBanNotice, type NativeGroupOwnerGroupNotice,
  type NativeGroupOwnerMemberNotice } from "./lib/adapters/group-moderation.ts";
import type { ProfileLikeImage } from "./lib/adapters/mention-like.ts";
import { ownGroupCardSession, type OwnGroupCardAccount } from "./lib/adapters/own-group-card.ts";
import { readAutoQuit } from "./lib/auto-quit.ts";
import { normalizeGameCommand, normalizeOriginalPictureCommand } from "./lib/command-prefix.ts";
import { canManagePackages, isCheckinCommandOwner, isMilkyOwnerSession } from "./lib/command-permissions.ts";
import { botOperationCommand, isBotVerificationInput } from "./lib/bot-operation.ts";
import { createRemoteControl, isRemoteControlCommand } from "./lib/remote-control.ts";
import { arkRankCredentialsPath, containsArkRankTokenInput, createArkRankCredentialSettings, isArkRankTokenCommand } from "./lib/ark-rank-credentials.ts";
import { hasPanelTransferCapability, matchPanelTransferCommand, type PanelTransferAccess } from "./lib/panel-transfer-command.ts";
import { configurePanelTransfer } from "./lib/panel-transfer-config.ts";
import { panelTransferPath } from "./lib/panel-transfer.ts";
import { CommandRegistry, sendCommandReply, type CommandContext } from "./lib/commands.ts";
import { readLocalConfig } from "./lib/config.ts";
import { readRequestOtherPolicies } from "./lib/request-other-policies.ts";
import { legacyLotusDirectories, readLotusGlobalConfig } from "./lib/lotus-global-config.ts";
import { dailyNoteCommands } from "./lib/daily-note.ts";
import { createDailyNoteReminders, dailyNoteReminderFeatureNames } from "./lib/daily-note-reminders.ts";
import { deviceCommands, isDeviceBindingInput, isDeviceBindingPayload, normalizeDeviceInfoCommand } from "./lib/device-commands.ts";
import { createDispatchPower, formatElapsed, isProcessMaster, readLegacyDispatchPause } from "./lib/dispatch-power.ts";
import { groupRecallPermission, quotedRecallSessions, readGroupRecallPermissions } from "./lib/quoted-recall.ts";
import { scheduleDispatchPower } from "./lib/dispatch-power-schedule.ts";
import { createFileToUrl, createImageToUrl, listenerFileBase } from "./lib/file-to-url.ts";
import { lockFile } from "./lib/file-lock.ts";
import { readFriendRequests } from "./lib/friend-requests.ts";
import { createFriendMessageReceipts, friendMessageNoticeSession, type FriendMessageNoticeSession,
  type NativeFriendRelationshipNotice } from "./lib/friend-message-notice.ts";
import { createMessageRecallCache, isRecallMedia, maxRecallMediaCacheBytes, maxRecallMediaCacheEntries, readRecallBody,
  type NativeFriendRecallNotice, type NativeGroupRecallNotice,
  type RecallBody, type RecallMedia, type RecallTextBody } from "./lib/message-recall-notice.ts";
import { createGachaBatch } from "./lib/gacha-batch.ts";
import { createPanelRebuild } from "./lib/panel-rebuild.ts";
import { gachaExpectationCommands, gachaExpectationModuleName, isGachaExpectationInput } from "./lib/gacha-expectation-commands.ts";
import { hoyoLabProfileCommands, isHoYoLabCookieInput } from "./lib/hoyolab-profile-commands.ts";
import { hoyoTransportForBot } from "./lib/hoyolab-network.ts";
import { createCaptchaService } from "./lib/captcha/service.ts";
import { runInitializationStage } from "./lib/initialization-progress.ts";
import { setDefaultCaptchaSolver } from "@lotus-yunzai/hoyo-client";
import { startImagePreviews } from "./lib/image-previews.ts";
import { markGeneratedImage } from "@lotus-yunzai/skia/generated-image";
import { readGroupDispatch } from "./lib/group-dispatch.ts";
import { createGroupRepeatOrder } from "./lib/group-repeat-order.ts";
import { readGroupInvitations } from "./lib/group-invitations.ts";
import { createKeywords } from "./lib/keywords.ts";
import { createKeywordStore } from "./lib/keyword-store.ts";
import { createLogCommand, isLogCommand } from "./lib/log-command.ts";
import { isLogLevel, isLogLevelCommand, logLevels, persistLogLevel, requestedLogLevel } from "./lib/log-level-command.ts";
import { chatSetting, createChatSettings } from "./lib/chat-settings.ts";
import { watchConfigFiles } from "./lib/config-watch.ts";
import { createManagedHandoff, type ManagedTlsListener } from "./lib/managed-handoff.ts";
import { installRejection, readInstallCatalog } from "./lib/install-catalog.ts";
import { createInstallCommand, hasValidInstallTarget, isInstallCommand, parseInstallName } from "./lib/install-command.ts";
import { isTerminalManagedUpdateProgress, managedUpdateScheduledBotLimit, type ManagedUpdateProgress, type ManagedUpdateRequest } from "./lib/managed-update-protocol.ts";
import { createMasterEnrollment, matchesMasterEnrollment } from "./lib/master-enrollment.ts";
import { appendBlackUser, updateHostAccessList } from "./lib/master-config.ts";
import { createMessageCounts } from "./lib/message-counts.ts";
import { createMessageStatistics } from "./lib/message-statistics.ts";
import { segment, setImagePreviews, type BotEvent, type FriendPoke, type GroupNotice, type GroupRequest,
  type MessageEvent, type MessageReply } from "./lib/messages.ts";
import { notifyOnlineMasters, onlineNoticeSeconds } from "./lib/online-notice.ts";
import { resolvePrivateFriendRoute } from "./lib/private-friend-route.ts";
import { panelApi, panelAssets } from "./lib/panel.ts";
import { createPanelOwnerSession } from "./lib/panel-owner-session.ts";
import { panelExtensionRoutes } from "./lib/panel-extension-routes.ts";
import { panelAtlasChannel } from "./lib/panel-atlas-channel.ts";
import { panelAtlasGallery } from "./lib/panel-atlas-gallery.ts";
import { panelGroupRankSettings } from "./lib/group-panel-rank-settings.ts";
import { panelStatusSettings } from "./lib/panel-status-settings.ts";
import { panelGameSettings } from "./lib/panel-game-settings.ts";
import { panelStarRailIndependentWarp } from "./lib/panel-starrail-independent-warp.ts";
import { panelStarRailWarpSettings } from "./lib/panel-starrail-warp-settings.ts";
import { panelGachaSettings } from "./lib/panel-gacha-settings.ts";
import { panelGenshinWishSettings } from "./lib/panel-genshin-wish-settings.ts";
import { panelGuidesSettings, panelGenshinGuideSettings, panelStarRailGuideSettings, panelZzzGuideSettings, panelGuideCalendarSettings } from "./lib/panel-guides-settings.ts";
import { panelIngressSettings } from "./lib/panel-ingress-settings.ts";
import { panelGroupRouting } from "./lib/panel-group-routing.ts";
import { panelNoticeSettings, panelNoticeMysSettings } from "./lib/panel-notice-settings.ts";
import { panelNoticeDeliverySettings } from "./lib/panel-notice-delivery-settings.ts";
import { panelZzzSettings } from "./lib/panel-zzz-settings.ts";
import { panelRemoteSettings } from "./lib/panel-remote-settings.ts";
import { panelRuntimeSettings } from "./lib/panel-runtime-settings.ts";
import { panelProcessScheduleSettings } from "./lib/panel-process-schedule-settings.ts";
import { panelDailyNoteSettings } from "./lib/panel-daily-note-settings.ts";
import { panelAtlasUpdate } from "./lib/panel-atlas-update.ts";
import { panelMusic } from "./lib/panel-music.ts";
import { panelBilibili } from "./lib/panel-bilibili.ts";
import { panelDouyin } from "./lib/panel-douyin.ts";
import { panelPartner } from "./lib/panel-partner.ts";
import { panelMediaEnvironment } from "./lib/panel-media-environment.ts";
import { panelWebLogin } from "./lib/panel-web-login.ts";
import { panelCheckinSchedule } from "./lib/panel-checkin-schedule.ts";
import { panelAccountPermissions, panelGroupExportPermissions, panelMediaDownloadPermissions, panelMediaOwnerPermissions,
  panelMediaPreviewPermissions } from "./lib/panel-account-permissions.ts";
import { panelGlobalPermissions } from "./lib/panel-global-permissions.ts";
import { panelGroupNoticeSettings, panelGroupSettings } from "./lib/panel-group.ts";
import { panelGroupManagement } from "./lib/panel-group-management.ts";
import { panelGroupCleanup } from "./lib/panel-group-cleanup.ts";
import { panelGuobaRoutes } from "./lib/panel-guoba-routes.ts";
import { webMountPage } from "./lib/panel-web-mount.ts";
import { isPassportLoginInput, passportLoginCommands } from "./lib/passport-login.ts";
import { repairLegacyPassportCookies, scheduleLegacyPassportCookieRepair } from "./lib/passport-cookie-repair.ts";
import { createPluginLoadingReporter, parsePluginLoadMilliseconds, pluginProbeTokenEnvironment } from "./lib/plugin-load-progress.ts";
import { LegacyPlugins } from "./lib/plugins/legacy.ts";
import type { LegacyExitReason } from "./lib/plugins/exit-hooks.ts";
import { HandlerScope } from "./lib/plugins/handler.ts";
import { LegacyTasks, legacyHostCronTimeZone } from "./lib/plugins/tasks.ts";
import { loadPlugins, systemModuleName, type PluginLoadReport } from "./lib/plugins/loader.ts";
import { stopStaticRenderer } from "./lib/renderer/shotium.ts";
import { accountScopePermission, readMasterPermissions } from "./lib/permissions.ts";
import { isStarRailGachaLinkMessage, readPrivateAccess, starRailLinkEntry, zzzLinkEntry } from "./lib/private-access.ts";
import { isGenshinPayLogLinkCandidate } from "@lotus-yunzai/hoyo-client/genshin-pay-log";
import { createProcessReceipts, type ProcessReceipt } from "./lib/process-receipts.ts";
import { takeLegacyProcessReceipt } from "./lib/legacy-process-receipts.ts";
import { createPublicFiles, maxPublicFileBytes } from "./lib/public-files.ts";
import { createMediaDelivery, sendSessionMedia, type MediaDelivery } from "./lib/media-delivery.ts";
import { createMiyousheBalanceQuery, miyousheBalanceProfile } from "./lib/miyoushe-balance.ts";
import { createMiyousheOverview } from "./lib/miyoushe-overview.ts";
import { createMiyousheWeb, isMiyousheWebCommand, MiyoushePreviewSettingsError, MiyousheSettingsError,
  miyousheWebSettings } from "./lib/miyoushe-web.ts";
import { createMiyousheShopCatalog } from "./lib/miyoushe-shop-catalog.ts";
import { createMiyousheShopPlans, MiyousheShopPlanError } from "./lib/miyoushe-shop-plans.ts";
import { trackingGame, trackingGames } from "./lib/miyoushe-shop-tracking.ts";
import { createCommandDelegation, delegationSession } from "./lib/command-delegation.ts";
import { canRestartHost, readRestartPausedAt, restartHost } from "./lib/process-restart.ts";
import { scheduleProcessRestart } from "./lib/process-restart-schedule.ts";
import { attachRuntimeLog, createPluginLog, runtimePluginLogger } from "./lib/runtime-log-writer.ts";
import { readRuntimeLogs, sanitizeRuntimeLog } from "./lib/runtime-logs.ts";
import { readRuntimeVersion } from "./lib/runtime-version.ts";
import { createRuntimeStatus, readRuntimeStatusRedisClients } from "./lib/runtime-status.ts";
import { createServerRedirect } from "./lib/server-redirect.ts";
import { httpStatus, readServerSettings } from "./lib/server.ts";
import { createTerminalInput } from "./lib/terminal-input.ts";
import { createTerminalReply } from "./lib/terminal-reply.ts";
import { previousUpdateDirectory } from "./lib/update-activation.ts";
import { verifyMovedHttpsPaths } from "./lib/update-https-paths.ts";
import { verifyMovedRuntimePaths } from "./lib/update-runtime-paths.ts";
import { verifyMovedWebMount } from "./lib/update-web-mount.ts";
import { createUpdateCommand, describeUpdateProgress, hasValidUpdateTarget, isUpdateCommand } from "./lib/update-command.ts";
import { readUpdateHistory } from "./lib/update-history.ts";
import { createUpdateLogCommand, isUpdateLogCommand } from "./lib/update-log-command.ts";
import { createUpdateCheckCommand, isUpdateCheckCommand } from "./lib/update-check-command.ts";
import { readUpdateAvailability } from "./lib/update-candidate-git.ts";
import { createUpdateNotices, normalizedUpdateNoticeCron, persistUpdateNoticeSettings, readUpdateNoticeSettings, updateNoticeSettingCommand } from "./lib/update-notice.ts";
import { scheduleUpdates } from "./lib/update-schedule.ts";
import { readStorageConnection } from "./lib/valkey-config.ts";
import type { GroupBannedWords } from "./plugins/group/banned-words.ts";
import type { FriendMessageNotice, FriendPokeNotice, FriendRecallNotice, FriendRelationshipNotice, FriendRequestNotice, GroupAddNotice, GroupRecallNotice, GroupVerification,
  TemporaryMessageNotice } from "./plugins/group/index.ts";
import { createGroupJoinReview, isGroupJoinReviewInput } from "./lib/group-join-review.ts";
import { createRequestClaim } from "./lib/request-claim.ts";
import { readOriginalQqVoice, standaloneVoicePart } from "./lib/qq-voice.ts";
import { readOriginalQqVideo, standaloneVideoPart } from "./lib/qq-video.ts";
import type { NativeTemporaryMessageNotice } from "./lib/temporary-message-notice.ts";
import type { GroupLeaveBlacklist } from "./plugins/group/group-leave-blacklist.ts";
import type { GroupMessageNotice } from "./plugins/group/group-message-notice.ts";
import type { GroupOwnerAdminNotice } from "./plugins/group/group-owner-admin-notice.ts";
import type { GroupOwnerBanNotice } from "./plugins/group/group-owner-ban-notice.ts";
import type { GroupOwnerGroupNotice } from "./plugins/group/group-owner-group-notice.ts";
import type { GroupOwnerInvitationNotice } from "./plugins/group/group-owner-invitation-notice.ts";
import type { GroupOwnerJoinRequestNotice } from "./plugins/group/group-owner-join-request-notice.ts";
import type { GroupOwnerMemberNotice } from "./plugins/group/group-owner-member-notice.ts";
import type { OwnerNoticeRecipients } from "./plugins/group/owner-notice-recipients.ts";
import type { CalendarSchedule, CalendarScheduleTarget } from "./plugins/guides/calendar-schedule.ts";

declare global {
  var redis: Awaited<ReturnType<typeof connectStorage>> | undefined;
}

const commands = new CommandRegistry();
if (import.meta.main) installTerminalLogging();
const terminalOutput = (message: string) => { process.stdout.write(message + "\n"); };
const keywordFeatureNames = ["添加消息", "group", "@lotus-yunzai/group"];
const leaveBlacklistNoticeNames = ["退群自动拉黑", "group", "@lotus-yunzai/group"];
const leaveBlacklistRequestNames = ["退群黑名单入群拦截", "group", "@lotus-yunzai/group"];
const leaveBlacklistManageNames = ["退群黑名单管理", "group", "@lotus-yunzai/group"];
const managedBlacklistNames = ["[group] 群管黑名单", "group", "@lotus-yunzai/group"];
const managedWhitelistNames = ["[group] 群管白名单", "group", "@lotus-yunzai/group"];
const groupBannedWordsNames = ["[group] 违禁词", "group", "@lotus-yunzai/group"];
const groupScreenedWordsNames = ["[group] 屏蔽词", "group", "@lotus-yunzai/group"];
const timedGroupMuteNames = ["[group] 定时群禁言", "group", "@lotus-yunzai/group"];
const groupAddNoticeNames = ["[group] 加群申请通知", "group", "@lotus-yunzai/group"];
const friendRequestNoticeNames = ["[group] 好友申请通知", "group", "@lotus-yunzai/group"];
const friendMessageNoticeNames = ["[group] 好友消息通知", "group", "@lotus-yunzai/group"];
const temporaryMessageNoticeNames = ["[group] 群临时消息通知", "group", "@lotus-yunzai/group"];
const friendRelationshipNoticeNames = ["[group] 好友增减通知", "group", "@lotus-yunzai/group"];
const friendPokeNoticeNames = ["[group] 好友戳一戳通知", "group", "@lotus-yunzai/group"];
const friendRecallNoticeNames = ["[group] 好友撤回通知", "group", "@lotus-yunzai/group"];
const groupRecallNoticeNames = ["[group] 群撤回通知", "group", "@lotus-yunzai/group"];
const groupMessageNoticeNames = ["[group] 群消息通知", "group", "@lotus-yunzai/group"];
const groupOwnerMemberNoticeNames = ["[group] 群成员变动通知", "group", "@lotus-yunzai/group"];
const groupOwnerAdminNoticeNames = ["[group] 群管理变动通知", "group", "@lotus-yunzai/group"];
const groupOwnerBanNoticeNames = ["[group] 机器人禁言通知", "group", "@lotus-yunzai/group"];
const groupOwnerGroupNoticeNames = ["[group] 群聊列表变动通知", "group", "@lotus-yunzai/group"];
const groupOwnerJoinRequestNoticeNames = ["[group] 加群申请主人通知", "group", "@lotus-yunzai/group"];
const groupOwnerInvitationNoticeNames = ["[group] 群邀请主人通知", "group", "@lotus-yunzai/group"];
const noticeSettingsNames = ["[group] 通知设置", "group", "@lotus-yunzai/group"];
const chatSettingsNames = ["[group] 设置", "group", "@lotus-yunzai/group"];
const privateCredentialField = /\b(?:authkey|s?token|ltoken|cookie_token|login_ticket|account_mid|ltmid|stmid|combo_token)(?:_v2)?(?:\s|["']|%22|%27)*(?:=|:|%3d)/iu;

function isPrivateCredentialMessage(text: string): boolean {
  return isBotVerificationInput(text) || privateCredentialField.test(text) || isCloudTokenInput(text) || isHoYoLabCookieInput(text) || isPassportLoginInput(text) ||
    isDeviceBindingInput(text) || isZzzGachaLinkMessage(text) || isStarRailGachaLinkMessage(text) ||
    isGenshinPayLogLinkCandidate(text) || hasPanelTransferCapability(text) || containsPanelSignatureChallenge(text);
}

function containsPanelTransferCapability(message: MessageEvent["message"]): boolean {
  if (typeof message === "string") return hasPanelTransferCapability(message);
  return hasPanelTransferCapability(message.map(part => part.type === "text" ? part.text : "").join(""));
}

function isPanelTransferInput(event: MessageEvent): boolean {
  return [event.msg, event.raw_message].some(hasPanelTransferCapability) || containsPanelTransferCapability(event.message);
}

function isGameSignatureInput(event: MessageEvent): boolean {
  const text = typeof event.message === "string" ? event.message :
    event.message.map(part => part.type === "text" ? part.text : "").join("");
  return [event.msg, event.raw_message, text].some(containsPanelSignatureChallenge);
}
const groupVerificationNames = ["[group] 入群验证", "group", "@lotus-yunzai/group"];
const privateGroupNames = ["[group] 私聊群管", "group", "@lotus-yunzai/group"];
const calendarScheduleNames = ["[guides] 定时日历", "guides", "@lotus-yunzai/guides"];
const gachaExpectationNames = ["[gacha] 抽卡期望", gachaExpectationModuleName];
const processFeatureNames = ["进程管理", "system", systemModuleName];
const updateFeatureNames = ["更新", "system", systemModuleName];
const installFeatureNames = ["安装插件", "system", systemModuleName];
const recallFeatureNames = ["回复撤回", "system", systemModuleName];
const atlasMaintenanceCommand = /^#?(?:更新图鉴|图鉴更新|检查图鉴更新|图鉴检查更新|重置图鉴|图鉴重置|清空图鉴|全量更新图鉴|图鉴全量更新)$/u;

function isRecallCommand(event: MessageEvent): boolean {
  return /^#?撤回$/u.test(event.msg);
}

if (import.meta.main) {
  const updateProbeToken = process.env[pluginProbeTokenEnvironment];
  const probingUpdate = updateProbeToken !== undefined;
  const reportLoading = createPluginLoadingReporter();
  const handoff = createManagedHandoff();
  const legacy = new LegacyPlugins(() => handoff.accepting);
  const publicFiles = createPublicFiles();
  let fileBase: URL | undefined;
  const chatMediaLinks = createChatMediaLinks(createFileToUrl(publicFiles, {}, () => stopping ? undefined : fileBase),
    () => fileBase !== undefined && !stopping);
  const quotedImageTools = createQuotedImageTools();
  const groups = new OneBotGroups();
  const leaveGroup = createManualGroupLeave();
  const pending = new Set<Promise<void>>();
  const boundDeliveries = new Map<string, Promise<void>>();
  const pendingCounts = new Set<Promise<void>>();
  const shutdown = Promise.withResolvers<void>();
  const lifecycle = new AbortController();
  const groupRepeatOrder = createGroupRepeatOrder(lifecycle.signal);
  const handoffSession = new AbortController();
  const stopWatchingHandoff = handoff.onDisconnect(() => handoffSession.abort());
  lifecycle.signal.addEventListener("abort", stopWatchingHandoff, { once: true });
  const moduleTasks = new LegacyTasks(() => handoff.accepting && !lifecycle.signal.aborted, legacyHostCronTimeZone);
  const pendingModuleTasks = new Set<() => void>();
  let moduleTasksActive = false;
  function whenModuleTasksActive(start: () => void) {
    if (moduleTasksActive && handoff.accepting && !lifecycle.signal.aborted) start();
    else if (!lifecycle.signal.aborted) pendingModuleTasks.add(start);
    return () => pendingModuleTasks.delete(start);
  }

  function validateModuleCron(cron: string) {
    if (stopping || lifecycle.signal.aborted) return false;
    try {
      const candidate = moduleTasks.prepare([{ owner: new HandlerScope(), app: {
        name: $t("app.text_89fd7f6097"), task: { cron, fnc() {}, log: false },
      } }]);
      candidate.cancel();
      return true;
    } catch {
      return false;
    }
  }

  function registerModuleTask(name: string, cron: string, run: () => Promise<unknown>,
    runAtStartup: boolean | (() => Promise<unknown>) = false) {
    const owner = new HandlerScope();
    let startup: Promise<void> | undefined;
    const start = () => {
      try {
        moduleTasks.register(owner, { name, task: { cron, fnc: run, log: false } });
      } catch {
        console.warn($t("app.text_242958f459", { "name": name }));
        return;
      }
      if (runAtStartup) {
        startup = Promise.resolve().then(async () => {
          if (!lifecycle.signal.aborted && handoff.accepting) {
            await (typeof runAtStartup === "function" ? runAtStartup : run)();
          }
        }).catch(() => console.warn($t("app.text_40832b56e7", { "name": name })));
        const finished = startup;
        pending.add(finished);
        void finished.finally(() => pending.delete(finished));
      }
    };
    const cancelStart = whenModuleTasksActive(start);
    return async () => {
      cancelStart();
      await Promise.all([moduleTasks.cancel(new Set([owner])), startup]);
    };
  }
  const commandDelegation = createCommandDelegation({
    signal: AbortSignal.any([lifecycle.signal, handoffSession.signal]),
    mayDelegate: event => !stopping && handoff.accepting && (event.adapter === "milky"
      ? isMilkyOwnerSession(event) && onlineMilkyBotId() === event.self_id
      : event.boundAccount === true && event.self_id !== undefined && event.user_id !== undefined &&
        masterPermissions.isMaster(event.self_id, event.user_id)),
    isMaster: (botId, userId) => masterPermissions.isMaster(botId, userId),
    async run(event, handled) {
      if (!stopping && handoff.accepting && groupDispatch.admit(event)) await dispatchMessage(event, handled);
    },
  });
  const roleProfiles = createProfileStore(Bun.env.LOTUS_PROFILE_DIR || undefined);
  const accountCookieStatus = createAccountCookieStatus(roleProfiles);
  const gameProfileDefaults = createGameProfileDefaults(fileURLToPath(new URL(gameProfileDefaultsPath + "/", import.meta.url)), roleProfiles, lockFile);
  const publicUidQuery = createPublicUidQuery();
  const gameProfileCommands = createGameProfileCommands(roleProfiles, gameProfileDefaults);
  const gachaBatch = createGachaBatch({
    listIds: roleProfiles.listIds,
    signal: lifecycle.signal,
  });
  const panelRebuild = createPanelRebuild(roleProfiles, lifecycle.signal);
  const arkSelfRank = createArkSelfRankCommand(roleProfiles);
  const legacyPanelRecoveryEnabled = () => readLegacyPanelRecoveryEnabled(root);
  const legacyPanelRecovery = createLegacyPanelRecoveryFlow({
    enabled: legacyPanelRecoveryEnabled,
    async authorize({ game, uid, profileId }, session) {
      const qq = String(session.user);
      const selected = await roleProfiles.savedRole(qq, profileId, game).catch(() => undefined);
      if (!selected || selected.uid !== uid) return;
      const sameRole = (role: typeof selected | undefined) => role?.uid === uid && role.region === selected.region &&
        role.gameBiz === selected.gameBiz;
      const read = async () => {
        const role = await roleProfiles.savedRole(qq, profileId, game).catch(() => undefined);
        if (!sameRole(role)) return;
        const auth = await roleProfiles.requestSelectedContext(qq, profileId, game).catch(() => undefined);
        if (auth && sameRole(auth.role)) return previewRedeemIdentity(auth);
      };
      const account = await read();
      if (account) return async () => session.isCurrent() && (await read()) === account;

    },
  });

  async function exportOwnedPanel(game: "gs" | "sr", uid: string, authorized: () => Promise<boolean>,
    event: MessageEvent, signal: AbortSignal) {
    const { uploadFile } = event;
    if (!uploadFile || event.user_id === undefined) return $t("app.text_84db7aa2ac");
    const authorize = async (target: string) => target === uid && await authorized();
    try {
      if (game === "gs") {
        const [{ createGenshinSignedPanelExport }, { createGenshinPanelArchive }, { readPanelTheme }] = await Promise.all([
          import("./plugins/genshin/panel/panel-file.ts"), import("./plugins/genshin/panel/panel.ts"),
          import("./plugins/genshin/panel/theme.ts"),
        ]);
        return await createGenshinSignedPanelExport(createGenshinPanelArchive(lockFile), lifecycle.signal, readPanelTheme)(
          { uid, authorize }, { ...event, privateCredentialSignal: signal });
      }
      const { createStarRailSignedPanelExport } = await import("./plugins/starrail/panel-signed-export.ts");
      return await createStarRailSignedPanelExport(lockFile, lifecycle.signal)({
        qq: String(event.user_id), uid, authorize, uploadFile, signal,
      });
    } catch {
      if (!signal.aborted) return $t("app.text_34f7c4a9a1");
    }
  }
  const restartPausedAt = readRestartPausedAt();
  const durablePause = handoff.powerState;
  const recordedPause = durablePause?.load();
  const initialPause = recordedPause === undefined ? handoff.pausedAt ?? restartPausedAt : recordedPause ?? undefined;
  const dispatchPower = createDispatchPower(Date.now, initialPause,
    durablePause ? (value) => {
      if (!handoff.accepting) throw new Error($t("app.text_7588a8eb44"));
      durablePause.save(value);
      handoff.reportPower(value);
    } : undefined);
  let plugins: PluginLoadReport | undefined;
  let chatSettings: ReturnType<typeof createChatSettings> | undefined;
  let stopPowerSchedule: (() => Promise<void>) | undefined;
  let stopRestartSchedule: (() => Promise<void>) | undefined;
  let stopUpdateSchedule: (() => Promise<void>) | undefined;
  let stopMilky: (() => Promise<void>) | undefined;
  let checkinRuntime: ReturnType<typeof createCheckinScheduleRuntime> | undefined;
  const readCheckinStatus = checkinStatus(Bun.env.LOTUS_PROFILE_DIR || undefined);
  const unregisterCheckin = checkinUnregistration(Bun.env.LOTUS_PROFILE_DIR || undefined,
    async () => { await checkinRuntime?.reconcileExistingPlans(); });
  let dailyNoteReminders: ReturnType<typeof createDailyNoteReminders> | undefined;
  let captchaService: ReturnType<typeof createCaptchaService> | undefined;
  let manualCaptcha: ReturnType<typeof import("./lib/captcha/manual-relay.ts").createManualCaptchaRelay> | undefined;
  let miyousheWeb: ReturnType<typeof createMiyousheWeb> | undefined;
  let panelOwnerSession: ReturnType<typeof createPanelOwnerSession> | undefined;
  let shopPlans: ReturnType<typeof createMiyousheShopPlans> | undefined;
  let milkyOnline: { id: number; startedAt: number; signal: AbortSignal; send: MilkySession["send"];
    checkinNotify?: CheckinNotifyTransport; ownGroupCardAccount: OwnGroupCardAccount;
    timedWholeMute: MilkySession["timedWholeMute"]; noticeAccount: NoticeGroupAccount; uploadFile: MilkySession["uploadFile"] } | undefined;
  let stopping = false;
  let shutdownRequested = false;
  let legacyBot: object | undefined;
  let legacyProcessReady = false;
  let legacyExitHooksRan = false;
  let exitReason: LegacyExitReason = "exit";
  let consoleInput: ReturnType<typeof createTerminalInput> | undefined;
  const servers: Pick<ReturnType<typeof startOneBot>, "stop">[] = [];
  const root = new URL("./", import.meta.url);
  const i18nSettings = await initializeI18n(root);
  const previous = !probingUpdate && handoff.managed && !handoff.accepting
    ? await previousUpdateDirectory(fileURLToPath(root)).catch(() => undefined)
    : undefined;
  if (!probingUpdate) {
    whenModuleTasksActive(() => {
      const active = AbortSignal.any([lifecycle.signal, handoffSession.signal]);
      const running = startImagePreviews(root, active, setImagePreviews, previous ? pathToFileURL(previous + sep) : undefined);
      pending.add(running);
      void running.then(() => pending.delete(running));
    });
  }
  const mediaDelivery = createMediaDelivery(fileURLToPath(new URL("data", root)), () => stopping ? undefined : fileBase);
  const processReceipts = createProcessReceipts(root);
  type ProcessAction = {
    readonly kind: "stop" | "restart";
    readonly at: number;
    readonly targets: readonly ProcessReceipt["target"][];
    readonly pausedAt?: number;
  };
  let processAction: ProcessAction | undefined;
  let masterPermissions: Awaited<ReturnType<typeof readMasterPermissions>>;
  let privateAccess: Awaited<ReturnType<typeof readPrivateAccess>>;
  let autoFriend: Awaited<ReturnType<typeof readFriendRequests>>;
  let groupDispatch: Awaited<ReturnType<typeof readGroupDispatch>>;
  let otherPolicies: Awaited<ReturnType<typeof readRequestOtherPolicies>>;
  const imageOcr = createImageOcr();
  const groupAvatar = createGroupAvatarCommand();
  const legacyCharacterAliases = legacyCharacterAliasCommands(lockFile, lifecycle.signal, fileURLToPath(root));
  const ownerAccount = createOwnerAccountCommand();
  const ownerQzone = createOwnerQzoneCommand();
  let leaveBlacklist: { policy: GroupLeaveBlacklist; signal: AbortSignal } | undefined;
  let managedBlacklist: {
    policy: { blocked(userId: number): Promise<boolean>; shouldAutoUnmute(userId: number): Promise<boolean> };
    signal: AbortSignal;
  } | undefined;
  const managedModerationResults = new Map<string, boolean>();
  const managedModerationPending = new Set<string>();
  const lastMemberMutes = new Map<string, { time: number; revisions: Set<string> }>();
  let groupBannedWords: { policy: GroupBannedWords; signal: AbortSignal } | undefined;
  let groupAddNotice: { policy: GroupAddNotice; signal: AbortSignal } | undefined;
  let friendRequestNotice: { policy: FriendRequestNotice; signal: AbortSignal } | undefined;
  let friendMessageNotice: { policy: FriendMessageNotice; signal: AbortSignal } | undefined;
  let temporaryMessageNotice: { policy: TemporaryMessageNotice; signal: AbortSignal } | undefined;
  let friendRelationshipNotice: { policy: FriendRelationshipNotice; signal: AbortSignal } | undefined;
  let friendPokeNotice: { policy: FriendPokeNotice; signal: AbortSignal } | undefined;
  let friendRecallNotice: { policy: FriendRecallNotice; signal: AbortSignal } | undefined;
  let groupRecallNotice: { policy: GroupRecallNotice; signal: AbortSignal } | undefined;
  let groupMessageNotice: { policy: GroupMessageNotice; signal: AbortSignal } | undefined;
  let groupOwnerMemberNotice: { policy: GroupOwnerMemberNotice; signal: AbortSignal } | undefined;
  let groupOwnerAdminNotice: { policy: GroupOwnerAdminNotice; signal: AbortSignal } | undefined;
  let groupOwnerBanNotice: { policy: GroupOwnerBanNotice; signal: AbortSignal } | undefined;
  let groupOwnerGroupNotice: { policy: GroupOwnerGroupNotice; signal: AbortSignal } | undefined;
  let groupOwnerJoinRequestNotice: { policy: GroupOwnerJoinRequestNotice; signal: AbortSignal } | undefined;
  let groupOwnerInvitationNotice: { policy: GroupOwnerInvitationNotice; signal: AbortSignal } | undefined;
  let ownerNoticeRecipients: { policy: OwnerNoticeRecipients; signal: AbortSignal } | undefined;
  const notifiedFriendRequests = new Set<string>();
  const notifiedPrivateMessages = new Set<string>();
  const pendingPrivateNotices = new Set<string>();
  const friendNoticeHints = new Map<string, number>();
  let groupVerification: { policy: GroupVerification; signal: AbortSignal } | undefined;
  function requestStorage(feature: "group-join-review" | "friend-review" | "group-invitation-review" | "friend-message-notice" |
    "owner-friend-reply" | "owner-message-relay") {
    const redis = globalThis.redis;
    if (!redis) return;
    const namespace = (key: string) => `lotus-yunzai:${feature}:${key}`;
    return {
      read: (key: string) => redis.get(namespace(key)),
      async write(key: string, value: string, ttl: number) { await redis.set(namespace(key), value, { EX: ttl }); },
      async claim(key: string, value: string, ttl: number) { return await redis.set(namespace(key), value, { EX: ttl, NX: true }) === "OK"; },
      async release(key: string, value: string) {
        await redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
          { keys: [namespace(key)], arguments: [value] });
      },
    };
  }
  const groupJoinReview = createGroupJoinReview(() => requestStorage("group-join-review"));
  const friendReview = createRequestClaim(() => requestStorage("friend-review"));
  const invitationReview = createRequestClaim(() => requestStorage("group-invitation-review"));
  const invitationReceipts = createMilkyInvitationReceipts(() => requestStorage("group-invitation-review"));
  const friendNoticeReceipts = createFriendMessageReceipts(() => requestStorage("friend-message-notice"));
  const ownerFriendReplyClaim = createRequestClaim(() => requestStorage("owner-friend-reply"));
  const ownerMessageRelay = createOwnerMessageRelay({
    claim: createRequestClaim(() => requestStorage("owner-message-relay")),
    isMaster: (botId, userId) => masterPermissions.isMaster(botId, userId),
    privateCredential: isPrivateCredentialMessage,
    resolveAccount(botId, adapter) {
      const candidates: OwnerRelayAccount[] = [];
      function add(adapterName: OwnerRelayAccount["adapter"], gateway: CheckinNotifyTransport | undefined, notice: NoticeGroupAccount | undefined,
        uploadFile: MilkySession["uploadFile"] | undefined) {
        if (!gateway?.friendship || !notice) return;
        candidates.push({
          botId, adapter: adapterName, friendship: gateway.friendship, groups: notice.listGroups,
          send: (kind, target, reply) => kind === "friend" ? gateway.sendPrivate(target, reply) : gateway.sendGroup(target, reply),
          uploadFile,
        });
      }
      if (adapter !== "milky") add("onebot", groups.checkinNotifications().find(account => account.botId === botId),
        groups.noticeAccounts().find(account => account.botId === botId), groups.captureFileUpload(botId));
      const milky = milkyOnline;
      if (adapter !== "onebot" && milky?.id === botId && !milky.signal.aborted) add("milky", milky.checkinNotify, milky.noticeAccount, milky.uploadFile);
      return candidates.length === 1 ? candidates[0] : undefined;
    },
  });
  function recallCache(feature: "friend" | "group") {
    return createMessageRecallCache(() => {
      const redis = globalThis.redis;
      if (!redis) return;
      const prefix = `lotus-yunzai:${feature}-recall-notice:`;
      const mediaExpirations = prefix + "image-expirations";
      const mediaSizes = prefix + "image-sizes";
      return {
        async has(key) { return await redis.exists(prefix + key) !== 0; },
        async save(key, value, ttl, withMedia) {
          if (!withMedia) {
            await redis.set(prefix + key, value, { EX: ttl, NX: true });
            return;
          }
          await redis.eval(`
            if redis.call('EXISTS', KEYS[1]) ~= 0 then return 0 end
            local time = redis.call('TIME')
            local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
            for _, expired in ipairs(redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now)) do
              redis.call('HDEL', KEYS[3], expired)
              redis.call('ZREM', KEYS[2], expired)
            end
            if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[4]) then return 0 end
            local size = string.len(ARGV[1])
            local used = size
            for _, saved in ipairs(redis.call('HVALS', KEYS[3])) do used = used + tonumber(saved) end
            if used > tonumber(ARGV[3]) then return 0 end
            redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
            redis.call('ZADD', KEYS[2], now + tonumber(ARGV[2]) * 1000, KEYS[1])
            redis.call('HSET', KEYS[3], KEYS[1], size)
            return 1
          `, { keys: [prefix + key, mediaExpirations, mediaSizes],
            arguments: [value, String(ttl), String(maxRecallMediaCacheBytes), String(maxRecallMediaCacheEntries)] });
        },
        async take(key) {
          const result = await redis.eval(`
            local value = redis.call('GET', KEYS[1]);
            if not value or value == 'null' then return nil; end;
            redis.call('SET', KEYS[1], 'null', 'KEEPTTL');
            redis.call('ZREM', KEYS[2], KEYS[1]);
            redis.call('HDEL', KEYS[3], KEYS[1]);
            return value;
          `, { keys: [prefix + key, mediaExpirations, mediaSizes], arguments: [] });
          return typeof result === "string" ? result : null;
        },
      };
    });
  }
  const friendRecallCache = recallCache("friend");
  const groupRecallCache = recallCache("group");
  let activeRecallMediaReads = 0;
  const moderatedMessages = new Set<string>();
  let likeImageRenderer: ProfileLikeImage | undefined;
  let calendarSchedule: { policy: CalendarSchedule; signal: AbortSignal } | undefined;
  let runNamedCheckin: ReturnType<typeof gameCheckinCommands>["runNamed"] | undefined;
  let cloudGenshinWallet: ReturnType<typeof createCloudGenshinWalletQuery> | undefined;
  let miyousheBalance: ReturnType<typeof createMiyousheBalanceQuery> | undefined;
  let reviewInvitation: Awaited<ReturnType<typeof readGroupInvitations>>;
  let autoQuit: Awaited<ReturnType<typeof readAutoQuit>>;
  let masterEnrollment: ReturnType<typeof createMasterEnrollment>;
  let keywords: ReturnType<typeof createKeywords>;
  let counts: ReturnType<typeof createMessageCounts>;
  let onlineCooldown: number | undefined;
  let onlineVersion: string | undefined;
  let runtimeLog: Awaited<ReturnType<typeof attachRuntimeLog>> | undefined;
  let runtimeLogConfig: Record<string, unknown> = {};
  let runtimeLogRevision = 0;

  async function setRuntimeLogLevel(event: MessageEvent) {
    const terminal = event.message_type === "terminal";
    const session = event[delegationSession]?.signal;
    const canWrite = () => {
      if (stopping || !handoff.accepting || event.isDelegated || !canManagePackages(event)) return false;
      if (terminal) return masterPermissions.terminal;
      return session?.aborted === false && event.self_id !== undefined && event.user_id !== undefined &&
        masterPermissions.isMaster(event.self_id, event.user_id);
    };
    if (!canWrite()) {
      await event.reply($t("app.text_ee7b348d1b"));
      return;
    }
    const level = requestedLogLevel(event.msg);
    if (!level) {
      await event.reply($t("app.text_86b8dc08ba", { "value1": logLevels.join(",") }));
      return;
    }
    const signal = session ? AbortSignal.any([session, lifecycle.signal]) : lifecycle.signal;
    try {
      const changed = await persistLogLevel(root, level, canWrite, signal, () => {
        runtimeLogRevision++;
        runtimeLogConfig.log_level = level;
      });
      if (!signal.aborted) await event.reply(changed ? $t("app.text_7894441b12", { "level": level }) : $t("app.text_2fada410f1", { "level": level }));
    } catch {
      if (!signal.aborted) await event.reply($t("app.text_b84db17f0c"));
    }
  }
  const logCommand = createLogCommand(async (kind, query) => {
    await runtimeLog?.flush();
    return readRuntimeLogs(root, kind, query);
  });
  const updateLogCommand = createUpdateLogCommand((requested) =>
    plugins ? readUpdateHistory(root, plugins.directories, requested) : Promise.resolve(undefined));
  const updateCheckCommand = createUpdateCheckCommand(signal => readUpdateAvailability(fileURLToPath(root), signal));
  const checkForUpdate = (event: MessageEvent) => {
    const connection = event[delegationSession]?.signal;
    return updateCheckCommand(event, connection ? nativeOperationSignal(connection) : nativeOperationSignal());
  };
  let pendingUpdateSubmissions = 0;
  const updateNotices = createUpdateNotices({
    signal: lifecycle.signal,
    accepting: () => !stopping && !processAction && pendingUpdateSubmissions === 0 && handoff.accepting && !handoff.updating,
    read: signal => readUpdateAvailability(fileURLToPath(root), signal, true),
    async send(message, signal) {
      const owners = processOwnerTargets().flatMap(({ botId, adapter }) => masterPermissions.masterIds(botId)
        .filter(id => id !== botId)
        .map(id => ({ type: "private" as const, botId, id, adapter })));
      const target = masterPermissions.legacyMasterIds()
        .map(id => owners.find(owner => owner.id === id)).find(owner => owner !== undefined) ?? owners[0];
      if (!target || signal.aborted || !masterPermissions.isMaster(target.botId, target.id)) return "rejected";
      const connection = target.adapter === "milky" ? milkyOnline?.signal : undefined;
      const result = await sendReceipt(target, message, connection);
      return result.confirmed ? "confirmed" : result.retry ? "rejected" : "unknown";
    },
  });

  async function submitManagedUpdate(request: ManagedUpdateRequest, report: (status: ManagedUpdateProgress) => void) {
    pendingUpdateSubmissions++;
    try {
      await updateNotices.interrupt();
      return !stopping && handoff.update(request, report);
    } finally {
      pendingUpdateSubmissions--;
    }
  }

  async function configureUpdateNotice(event: MessageEvent, change: NonNullable<ReturnType<typeof updateNoticeSettingCommand>>) {
    const connection = event[delegationSession]?.signal;
    const signal = connection ? nativeOperationSignal(connection) : nativeOperationSignal();
    const authorize = () => !event.isDelegated && canManagePackages(event) &&
      (event.message_type === "terminal" ? masterPermissions.terminal :
        event.self_id !== undefined && event.user_id !== undefined && masterPermissions.isMaster(event.self_id, event.user_id) &&
        (event.adapter !== "milky" || onlineMilkyBotId() === event.self_id));
    if (signal.aborted) return;
    if (!authorize()) {
      await event.reply($t("app.text_ee7b348d1b"));
      return;
    }
    const cron = change.update_notice_cron === undefined ? undefined : normalizedUpdateNoticeCron(change.update_notice_cron);
    if (change.update_notice_cron !== undefined && (!cron || !validateModuleCron(cron))) {
      await event.reply($t("app.text_68ed859a66"));
      return;
    }
    try {
      const settings = await persistUpdateNoticeSettings(root, cron ? { update_notice_cron: cron } : change,
        signal, authorize, updateNotices.apply, validateModuleCron);
      if (!signal.aborted) await event.reply(cron ? $t("app.text_e804057834", { "update_notice_cron": settings.update_notice_cron }) :
        $t("app.text_5d8c169497", { "value1": settings.update_notice ? $t("app.text_8da97ddda9") : $t("app.text_3fd47edce4") }));
    } catch {
      if (!signal.aborted) await event.reply($t("app.text_a10bf57f6b"));
    }
  }

  const updateCommand = createUpdateCommand(async (event, requested, quiet, report, all, force) => {
    const target = sessionTarget(event);
    if (!target || !plugins) return false;
    if (await reportOldMilkySupervisor(event)) return true;
    return submitManagedUpdate({
      requested, ...(all ? { all: true } : {}), ...(force ? { force: true } : {}), quiet, target,
      ...updatePluginSnapshot(),
    }, report);
  });
  const installCommand = createInstallCommand({
    async list() {
      const catalog = await readInstallCatalog(root);
      const occupied = new Set(await readdir(new URL("plugins/", root)));
      return catalog.list.flatMap(({ name, approved }) => {
        const target = approved ? catalog.resolve(name) : undefined;
        return target && !occupied.has(target.directory) && !installRejection(target.url, target.directory, target.name) ? [name] : [];
      });
    },
    async install(event, name, report) {
      const target = sessionTarget(event);
      if (!target || !plugins) return false;
      const catalog = await readInstallCatalog(root);
      const approved = catalog.resolve(name);
      const legacy = catalog.list.find((entry) => parseInstallName(entry.name) === name);
      const rejection = approved ? installRejection(approved.url, approved.directory, approved.name) :
        legacy && installRejection(legacy.url, legacy.name);
      if (rejection) {
        await event.reply(rejection);
        return true;
      }
      if (!approved) {
        report("unavailable");
        return true;
      }
      if (await reportOldMilkySupervisor(event)) return true;
      return submitManagedUpdate({ install: name, quiet: false, target, ...updatePluginSnapshot() }, (status) => {
        if (status === "current") report("exists");
        else if (status === "dirty" || status === "ahead" || status === "diverged") report("failed");
        else if (status === "checking" || status === "building" || status === "switching" || status === "failed" ||
            status === "busy" || status === "rejected" || status === "unavailable" || status === "storage-changed") report(status);
      });
    },
  });

  async function reportOldMilkySupervisor(event: MessageEvent): Promise<boolean> {
    if (event.adapter !== "milky" || !handoff.managed || handoff.supportsAdapterReceipts) return false;
    await event.reply($t("app.text_857a28618d"));
    return true;
  }

  function updatePluginSnapshot() {
    return {
      directories: [...plugins?.directories ?? []].map(([name, metadata]) => ({ name, ...metadata })),
      scripts: plugins?.loadedScripts(),
      watchedScriptHashes: plugins?.watchedScriptHashes(),
    };
  }

  async function requestScheduledUpdate() {
    if (stopping || !plugins) return;
    const signal = lifecycle.signal;
    const targets = processOwnerTargets(masterPermissions.botIds().slice(0, managedUpdateScheduledBotLimit));
    const botIds = targets.filter((target) => target.adapter === undefined).map((target) => target.botId);
    const milkyBotIds = targets.filter((target) => target.adapter === "milky").map((target) => target.botId);
    const terminal = masterPermissions.terminal;
    const progress = Promise.withResolvers<ManagedUpdateProgress | undefined>();
    const abort = () => progress.resolve(undefined);
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (!await submitManagedUpdate({
        all: true, quiet: true,
        target: { type: "scheduled", botIds, terminal, ...(milkyBotIds.length ? { milkyBotIds } : {}) },
        ...updatePluginSnapshot(),
      }, (status) => { if (isTerminalManagedUpdateProgress(status)) progress.resolve(status); })) {
        progress.resolve("unavailable");
      }
      const result = await progress.promise;
      if (!result || result === "current" || result === "switching" || signal.aborted) return;
      const reply = $t("app.text_56aeb51c82", { "value1": describeUpdateProgress(result) });
      if (terminal) terminalOutput(reply);
      else console.warn($t("app.text_3976a5d3e5", { "reply": reply }));
      await Promise.all(targets.map((target) => sendProcessMessage(target, reply)));
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  function stop(code: number, reason: LegacyExitReason = "exit") {
    if (stopping) return;
    stopping = true;
    shutdownRequested = true;
    exitReason = reason;
    process.exitCode = code;
    handoff.reportPower(dispatchPower.pausedAt);
    lifecycle.abort();
    handoff.cancelUpdate();
    void stopPowerSchedule?.();
    void stopRestartSchedule?.();
    void stopUpdateSchedule?.();
    void updateNotices.stop();
    void moduleTasks.stop();
    void legacy.stopTasks();
    legacy.stopContexts();
    consoleInput?.close();
    shutdown.resolve();
  }
  const stopOnDisconnect = handoff.onDisconnect(() => stop(143));
  const stopForReplacement = handoff.onReplacement(() => stop(143, "restart"));

  async function sendProcessMessage(target: ProcessReceipt["target"], message: string, signal?: AbortSignal): Promise<boolean> {
    try {
      if (signal?.aborted) return false;
      if (target.type === "terminal") {
        terminalOutput(message);
        return true;
      }
      if (target.adapter === "milky") {
        const online = milkyOnline;
        if (!online || online.id !== target.botId || online.signal.aborted || (signal && signal !== online.signal)) return false;
        if (target.type === "masters") {
          const outcomes = await Promise.allSettled(masterPermissions.masterIds(target.botId)
            .filter((user_id) => user_id !== target.botId)
            .map((user_id) => online.send({ user_id }, message)));
          return outcomes.every((outcome) => outcome.status === "fulfilled" && outcome.value);
        }
        return await online.send(target.type === "private" ? { user_id: target.id } : { group_id: target.id }, message);
      }
      if (target.type === "private") return await groups.sendPrivate(target.botId, target.id, message);
      if (target.type === "masters") {
        const outcomes = await Promise.allSettled(masterPermissions.masterIds(target.botId)
          .filter((user) => user !== target.botId)
          .map((user) => groups.sendPrivate(target.botId, user, message)));
        return outcomes.every((result) => result.status === "fulfilled" && result.value);
      }
      await groups.sendGroup(target.botId, target.id, message);
      return true;
    } catch {
      return false;
    }
  }

  async function sendReceipt(target: ProcessReceipt["target"], message: string, signal?: AbortSignal): Promise<{
    confirmed: boolean;
    retry?: { pendingUsers?: readonly number[] };
  }> {
    async function delivery(send: (() => Promise<CheckinNotifyDelivery> | CheckinNotifyDelivery) | undefined) {
      if (signal?.aborted || !send) return "rejected" as const;
      try { return await send(); }
      catch { return "unknown" as const; }
    }
    if (target.type === "terminal") {
      const status = await delivery(() => { terminalOutput(message); return "confirmed"; });
      return { confirmed: status === "confirmed", ...(status === "rejected" && { retry: {} }) };
    }
    const online = milkyOnline;
    const transport = target.adapter === "milky"
      ? online?.id === target.botId && !online.signal.aborted && (!signal || signal === online.signal)
        ? online.checkinNotify : undefined
      : groups.checkinNotifications().find(binding => binding.botId === target.botId);
    if (target.type === "masters") {
      const allowed = new Set(masterPermissions.masterIds(target.botId));
      allowed.delete(target.botId);
      const users = target.pendingUsers ? target.pendingUsers.filter(id => allowed.has(id)) : [...allowed];
      const outcomes = await Promise.all(users.map(id => delivery(transport && (() => transport.sendPrivate(id, message)))));
      const pendingUsers = users.filter((_, index) => outcomes[index] === "rejected");
      return { confirmed: outcomes.every(status => status === "confirmed"),
        ...(pendingUsers.length > 0 && { retry: { pendingUsers } }) };
    }
    const status = await delivery(transport && (() => target.type === "group"
      ? transport.sendGroup(target.id, message) : transport.sendPrivate(target.id, message)));
    return { confirmed: status === "confirmed", ...(status === "rejected" && { retry: {} }) };
  }

  async function deliverProcessReceipt(botId?: number, update: boolean | "install" = false, adapter?: "milky", signal?: AbortSignal) {
    try {
      if (signal?.aborted) return;
      const take = update === "install" ? processReceipts.takeInstall : update ? processReceipts.takeUpdate : processReceipts.take;
      const receipt = await take(botId, adapter);
      if (!receipt) return;
      const elapsed = formatElapsed(Date.now() - receipt.at);
      let reply: string;
      if (receipt.kind === "update") {
        if (receipt.result === "rolled-back") reply = $t("app.text_0e3aef90e0");
        else if (receipt.repositories !== undefined) {
          reply = $t("app.text_fab382b885", { "repositories": receipt.repositories, "value2": receipt.revision.slice(0, 12) });
        } else {
          reply = $t("app.text_f82fe678b6", { "value1": receipt.revision.slice(0, 12) });
        }
        if (receipt.result === "updated" && receipt.preserved) reply += $t("app.text_105c512225");
      } else if (receipt.kind === "install") {
        reply = receipt.result === "rolled-back" ? $t("app.text_e54d8ac5d0", { "name": receipt.name }) :
          $t("app.text_c2abfa19e0", { "name": receipt.name, "value2": receipt.revision.slice(0, 12) });
      } else {
        reply = processReceiptText(receipt.kind, elapsed);
      }
      const result = await sendReceipt(receipt.target, reply, signal);
      if (result.retry) {
        const remaining = receipt.kind !== "install" && receipt.target.type === "masters"
          ? { ...receipt, target: { ...receipt.target, pendingUsers: result.retry.pendingUsers } } : receipt;
        await processReceipts.restore(remaining);
      }
      if (!result.confirmed) console.warn($t("app.text_a4d75f074b"));
    } catch {
      console.warn($t("app.text_42d358197b"));
    }
  }

  function processReceiptText(kind: "restart" | "stop", elapsed: string) {
    return kind === "restart" ? $t("app.text_a60615d78d", { "elapsed": elapsed }) : $t("app.text_32751597f5", { "elapsed": elapsed });
  }

  async function deliverLegacyProcessReceipt(botId?: number, adapter?: "milky", signal?: AbortSignal) {
    const redis = globalThis.redis;
    const active = botId === undefined ? lifecycle.signal : signal;
    if (!redis?.isReady || !active || active.aborted || !handoff.accepting) return;
    try {
      const claim = await takeLegacyProcessReceipt(redis, { botId, adapter, signal: active }, {
        bots: masterPermissions.botIds(), terminal: masterPermissions.terminal,
      });
      if (!claim) return;
      if (active.aborted || !handoff.accepting) {
        await claim.restore();
        return;
      }
      const { receipt } = claim;
      const reply = processReceiptText(receipt.kind, formatElapsed(Date.now() - receipt.at));
      const result = await sendReceipt(receipt.target, reply, signal);
      if (result.retry) await claim.restore(result.retry);
      if (!result.confirmed) console.warn($t("app.text_91868678e0"));
    } catch {
      console.warn($t("app.text_38f60d9ad1"));
    }
  }

  function queueStartupMessages(botId?: number, adapter?: "milky", signal?: AbortSignal) {
    if (stopping) return;
    const key = botId === undefined ? undefined : `${adapter ?? "onebot"}:${botId}`;
    const previous = key === undefined ? undefined : boundDeliveries.get(key);
    const delivery = (previous ?? Promise.resolve()).then(async () => {
      if (stopping || signal?.aborted) return;
      await Promise.all([
        deliverProcessReceipt(botId, false, adapter, signal),
        deliverProcessReceipt(botId, true, adapter, signal),
        deliverProcessReceipt(botId, "install", adapter, signal),
      ]);
      await deliverLegacyProcessReceipt(botId, adapter, signal);
      if (botId === undefined) return;
      await notifyOnlineMasters(botId, onlineCooldown, {
        signal: signal ?? lifecycle.signal,
        version: onlineVersion,
        masterIds: (id) => masterPermissions.masterIds(id),
        async claim(id, seconds) {
          const redis = globalThis.redis;
          return redis?.isReady === true && await redis.set(`Yz:loginMsg:${id}`, "1", { NX: true, EX: seconds }) === "OK";
        },
        send: (botId, id, message) => sendProcessMessage({ type: "private", botId, id, adapter }, message, signal),
      });
    });
    if (key !== undefined) boundDeliveries.set(key, delivery);
    pending.add(delivery);
    const finished = () => {
      pending.delete(delivery);
      if (key !== undefined && boundDeliveries.get(key) === delivery) boundDeliveries.delete(key);
    };
    void delivery.then(finished, finished);
  }

  function sessionTarget(event: MessageEvent): Exclude<ProcessReceipt["target"], { type: "masters" }> | undefined {
    const type = event.message_type;
    if (type === "terminal") return { type };
    const id = type === "group" ? event.group_id : event.user_id;
    const botId = event.self_id;
    if (event.adapter === "milky") {
      if (isMilkyOwnerSession(event) && botId && id) return { type, botId, id, adapter: "milky" };
      return;
    }
    if (event.boundAccount === true && botId && id) return { type, botId, id };
  }

  type OwnerTarget = Extract<ProcessReceipt["target"], { type: "masters" }>;

  function onlineMilkyBotId() {
    return milkyOnline?.signal.aborted === false ? milkyOnline.id : undefined;
  }

  function statusStorage(namespace: "status-photo" | "status-monitor") {
    return {
      async get(key: string) { return storage(namespace).get(key); },
      async set(key: string, value: string, ttlSeconds: number) { return storage(namespace).set(key, value, ttlSeconds); },
    };
  }

  function subscriptionTransport(): readonly BotNotifications[] {
    const sessions = [...groups.checkinNotifications()];
    const milky = milkyOnline;
    if (milky?.checkinNotify && !milky.signal.aborted && !sessions.some(bot => bot.botId === milky.id)) {
      sessions.push({ botId: milky.id, ...milky.checkinNotify, inlineImageByteLimit: maxPublicFileBytes });
    }
    return sessions;
  }

  async function scheduledCalendarTargets(groupIds: readonly number[], signal: AbortSignal): Promise<CalendarScheduleTarget[]> {
    const live = () => !signal.aborted && !lifecycle.signal.aborted && !stopping && handoff.accepting;
    const targets: CalendarScheduleTarget[] = [];
    const sessions = subscriptionTransport();
    for (const groupId of groupIds) {
      for (const session of sessions) {
        if (!live()) return targets;
        if (!groupDispatch.allowsScheduledGroup(session.botId, groupId, calendarScheduleNames)) continue;
        if (!await session.isGroupMember(groupId, session.botId).catch(() => false)) continue;
        if (!live()) return targets;
        targets.push({
          groupId,
          inlineImageByteLimit: session.inlineImageByteLimit,
          async send(message, active) {
            if (active.aborted || !live() || !await session.isGroupMember(groupId, session.botId).catch(() => false) ||
                active.aborted || !live()) return "rejected";
            return session.sendGroup(groupId, message);
          },
        });
        break;
      }
    }
    return targets;
  }

  function processOwnerTargets(botIds?: readonly number[]): OwnerTarget[] {
    const oneBot = new Set(groups.onlineBots());
    const milky = onlineMilkyBotId();
    const milkyOnly = milky !== undefined && !oneBot.has(milky) ? milky : undefined;
    const recipients = botIds ?? (milkyOnly === undefined ? [...oneBot] : [...oneBot, milkyOnly]);
    return recipients.map((botId) => botId === milkyOnly
      ? { type: "masters", botId, adapter: "milky" }
      : { type: "masters", botId });
  }

  async function controlProcess(event: MessageEvent, kind: ProcessAction["kind"]) {
    if (!isProcessMaster(event)) {
      await event.reply($t("app.text_ee7b348d1b"));
      return;
    }
    const target = sessionTarget(event);
    if (!target) return;
    if (processAction) return;
    if (kind === "restart" && !handoff.managed && !canRestartHost()) {
      await event.reply($t("app.text_43e292d493"));
      return;
    }

    await startProcessAction(kind, [target]);
  }

  async function startProcessAction(kind: ProcessAction["kind"], targets: readonly ProcessReceipt["target"][]) {
    if (stopping || processAction) return;
    const pausedAt = dispatchPower.pausedAt;
    processAction = { kind, at: Date.now(), targets: pausedAt === undefined ? targets : [], pausedAt };
    if (pausedAt === undefined) {
      const elapsed = formatElapsed(process.uptime() * 1000);
      const operation = kind === "restart" ? $t("app.text_5628228928") : $t("app.text_ca4d973c0b");
      const online = new Set(groups.onlineBots());
      const milky = onlineMilkyBotId();
      const outcomes = await Promise.all(targets
        .filter((target) => target.type !== "masters" ||
          (target.adapter === "milky" ? target.botId === milky : online.has(target.botId)))
        .map((target) => sendProcessMessage(target, $t("app.text_d8d48df2f5", { "operation": operation, "elapsed": elapsed }))));
      if (outcomes.includes(false)) console.warn($t("app.text_fe9a39c0ee"));
    }
    const currentPause = dispatchPower.pausedAt;
    if (kind === "restart" && currentPause !== pausedAt) {
      processAction = { ...processAction, targets: currentPause === undefined ? targets : [], pausedAt: currentPause };
    }
    stop(0, kind === "restart" ? "restart" : "exit");
  }

  async function dispatch(event: BotEvent) {
    if (stopping || !handoff.accepting) return;
    if (event.post_type !== "message" || event.message_type !== "terminal") {
      recordCount("receive", event, event.post_type === "message" ? event.message : undefined);
    }
    const group = event.post_type === "message" && event.message_type === "group" && !event.isDelegated &&
      event[delegationSession]?.signal.aborted === false ? event.group_id : undefined;
    const handling = groupRepeatOrder.dispatch(group, () => routeEvent(event));
    pending.add(handling);
    try {
      await handling;
    } finally {
      pending.delete(handling);
    }
  }

  function nativeOperationSignal(...scopes: AbortSignal[]) {
    return AbortSignal.any([lifecycle.signal, handoffSession.signal, dispatchPower.activeSignal, ...scopes]);
  }

  function ownCheckinSession(event: MessageEvent, features: readonly string[]) {
    const { user_id: user, self_id: bot, group_id: groupId, sender } = event;
    const group = event.message_type === "group" && event.sub_type !== "anonymous" &&
      groupId !== undefined && Number.isSafeInteger(groupId) && groupId > 0;
    const privateFriend = event.message_type === "private" && event.sub_type === "friend" && groupId === undefined;
    const connection = group ? event[delegationSession]?.signal : privateFriend ? event.privateCredentialSignal : undefined;
    if (!connection || event.isDelegated || event.attachmentOnly ||
        user === undefined || !Number.isSafeInteger(user) || user < 1 ||
        bot === undefined || !Number.isSafeInteger(bot) || bot < 1 || user === bot ||
        event.message_id === undefined || (sender?.user_id !== undefined && sender.user_id !== user && sender.user_id !== String(user))) return;
    const signal = nativeOperationSignal(connection);
    const isCurrent = () => !signal.aborted && !stopping && handoff.accepting && !dispatchPower.paused &&
      groupDispatch.allowsInbound(event) && groupDispatch.allows(event, features) && (event.adapter === "milky" ? onlineMilkyBotId() === bot : event.boundAccount === true);
    if (!isCurrent()) return;
    return { user, signal, privateFriend, isCurrent,
      async verifySession() { if (!isCurrent()) throw new DOMException($t("app.text_ff19f48457"), "AbortError"); },
    };
  }

  function allowsOwnerRelay(event: MessageEvent) {
    return !stopping && handoff.accepting && !dispatchPower.paused &&
      groupDispatch.allowsInbound(event) && groupDispatch.allows(event, ownerRelayFeatureNames);
  }

  async function routeEvent(event: BotEvent) {
    if (event.post_type === "message") {
      const normalized = groupDispatch.commandText(event);
      if (event.message_type === "group" && [normalized, event.raw_message].some(isDeviceBindingPayload)) {
        if (!event.isDelegated && !dispatchPower.paused && groupDispatch.admit(event) &&
            groupDispatch.allows(event, ["@lotus-yunzai/device"])) {
          const moderation = groupModerationSession(event);
          const active = moderation && nativeOperationSignal(moderation.signal);
          const message = moderation?.memberMessage;
          let recalled = false;
          if (active && message) {
            try {
              recalled = await message.canAct(active) && !active.aborted && await message.recall(active) === "confirmed";
            } catch {
              // Fall back to asking the sender to withdraw the message.
            }
          }
          if (active && !active.aborted) {
            if (!recalled) await event.reply($t("app.group-device-recall"), false, { recallMsg: 120, recallOriginal: false });
            await dispatchMessage(event);
          }
        }
        return;
      }
      if ([normalized, event.raw_message].some(isBotVerificationInput)) {
        const receipt = `#机器人验证:${event.adapter ?? "onebot"}:${event.message_type}:${event.group_id ?? ""}:${event.message_id ?? ""}`;
        if (isBotVerificationInput(normalized) && botOperationCommand(normalized) &&
            groupDispatch.admit({ ...event, raw_message: receipt })) await dispatchMessage(event);
        return;
      }
      if (isGameSignatureInput(event)) return;
    }
    if (event.post_type === "message" && (containsArkRankTokenInput(event.message) || isPanelTransferInput(event))) {
      if (groupDispatch.admit(event)) await dispatchMessage(event);
      return;
    }
    if (event.post_type !== "message") {
      if (event.post_type === "notice" && event.notice_type === "group" && event.sub_type === "decrease") {
        await handleGroupVerificationNotice(event);
      }
      if (dispatchPower.paused || await handleLeaveBlacklist(event)) return;
      if (stopping || !handoff.accepting || dispatchPower.paused) return;
    }
    if (await handleManagedBlacklist(event)) return;
    if (event.post_type === "message" && event.message_type === "group" && groupDispatch.allowsInbound(event) &&
        await handleGroupVerificationAnswer(event)) return;
    if (event.post_type === "message") {
      if (ownerMessageRelay.acceptsFileFollowup(event) && allowsOwnerRelay(event)) return dispatchMessage(event);
      if (event[chatFileRelaySource]?.relayOnly) return;
    }
    if (groupDispatch.admit(event)) {
      await handleEvent(event);
    } else if (event.post_type === "message" && event.message_type === "private" && !groupDispatch.allowsInbound(event)) {
      // A verified owner can recover the host lists from a friend session even after excluding themselves.
      const prepared = groupDispatch.prepare(event);
      await handleHostAccessList(prepared.event, prepared.allowNew);
    }
  }

  async function handleGroupVerificationNotice(event: GroupNotice) {
    const registration = groupVerification;
    const transport = groupModerationSession(event);
    if (!registration || !transport?.groupVerification) return;
    const { groupVerification: gate, signal: connection, act } = transport;
    const signal = nativeOperationSignal(registration.signal, connection);
    const { self_id: botId, group_id: groupId, user_id: userId, time, inviter_id: inviterId } = event;
    const scope = { adapter: gate.adapter, groupId, userId, botId, time, connection, signal };
    if (signal.aborted) return;
    if (event.sub_type === "decrease") {
      await registration.policy.leave({ ...scope, voluntary: event.decrease_type === "leave", dismissed: event.dismiss,
        operatorId: event.operator_id }).catch(() => {});
      return;
    }
    const active = () => !signal.aborted && groupDispatch.allowsGroupModeration(event) && groupDispatch.allows(event, groupVerificationNames);
    const protectedTarget = () => userId === botId || masterPermissions.isMaster(botId, userId) || masterPermissions.legacyMasterIds().includes(userId);
    if (!act || time === undefined || !active() || protectedTarget()) return;
    const subject = bindGroupVerificationSubject({ ...scope, time, inviterId, active,
      isProtected: protectedTarget, transport: gate, kick: running => act(running) });
    await registration.policy.join(subject).catch(() => {});
  }

  async function handleGroupVerificationAnswer(event: MessageEvent) {
    const registration = groupVerification;
    const transport = groupModerationSession(event);
    const { memberMessage } = transport ?? {};
    const { groupVerification: scope, self_id: botId, group_id: groupId, user_id: userId, message_id: messageId } = event;
    if (!registration || event.message_type !== "group" || event.isDelegated || !scope || !memberMessage?.send ||
        !botId || !groupId || !userId || messageId === undefined || !groupDispatch.allows(event, groupVerificationNames)) return false;
    const signal = nativeOperationSignal(registration.signal, scope.signal);
    const active = () => !signal.aborted && botId !== userId && !masterPermissions.isMaster(botId, userId) &&
      !masterPermissions.legacyMasterIds().includes(userId) && groupDispatch.allows(event, groupVerificationNames);
    if (!active()) return false;
    return await registration.policy.answer({ adapter: event.adapter ?? "onebot", botId, groupId, userId, messageId,
      text: event.raw_message, connection: scope.connection, signal,
      canAnswer: async () => active() && await memberMessage.canAct(signal) && active(),
      recall: async () => active() && await memberMessage.canAct(signal) && active() ? memberMessage.recall(signal) : "rejected",
      reply: async parts => active() && await memberMessage.send?.(parts, signal) === true && active(),
    }).catch(() => false);
  }

  async function handleManagedBlacklist(event: BotEvent): Promise<boolean> {
    const registration = managedBlacklist;
    if (event.post_type === "notice" && (event.notice_type !== "group" || event.sub_type !== "increase")) return false;
    if (event.post_type === "request" && (event.request_type !== "group" || event.sub_type !== "add")) return false;
    if (event.post_type === "message" && (event.message_type !== "group" || event.isDelegated)) return false;
    if (!registration || stopping || !handoff.accepting || dispatchPower.paused ||
        !groupDispatch.allowsGroupModeration(event) || !groupDispatch.allows(event, managedBlacklistNames)) return false;
    const { self_id: bot, group_id: group, user_id: user } = event;
    if (!group || !user || !bot || user === bot ||
        masterPermissions.isMaster(bot, user) || masterPermissions.legacyMasterIds().includes(user)) return false;
    const transport = groupModerationSession(event);
    if (!transport?.act || !transport.canModerate) return false;
    const id = event.post_type === "request" ? [event.groupRequestScope ?? "onebot", event.flag]
      : event.post_type === "message" ? (event.message_id === undefined ? undefined : [event.adapter ?? "onebot", event.message_id])
        : event.time;
    if (id === undefined) return false;
    if (event.post_type === "message" && moderatedMessages.has(moderatedMessageKey(event))) return true;
    const active = nativeOperationSignal(registration.signal, transport.signal);
    const blocked = () => registration.policy.blocked(user).catch(() => false);
    if (active.aborted || !await blocked() || active.aborted) return false;
    const key = JSON.stringify([bot, group, user]);
    const selection = JSON.stringify([key, event.post_type, id]);
    const seen = managedModerationResults.get(selection);
    if (seen !== undefined) return seen;
    if (managedModerationPending.has(key)) return true;
    managedModerationPending.add(key);
    try {
      if (!await transport.canModerate(active).catch(() => false) || active.aborted || !await blocked() || active.aborted ||
          masterPermissions.isMaster(bot, user) || masterPermissions.legacyMasterIds().includes(user)) return false;
      const result = await transport.act(active, "").catch(() => "unknown" as const);
      const handled = result !== "rejected";
      if (managedModerationResults.size >= 4096) managedModerationResults.delete(managedModerationResults.keys().next().value!);
      managedModerationResults.set(selection, handled);
      if (!handled || active.aborted) return handled;
      if (event.post_type === "request") {
        console.log(result === "confirmed" ? $t("app.text_08f0616b18") : $t("app.text_c520735fb5"));
      } else {
        const reply = result === "unknown" ? $t("app.text_38ffdbfd56")
          : event.post_type === "notice" ? $t("app.text_3220ea2ab0", { "user": user })
            : $t("app.text_5b8ee46e0e", { "user": user });
        try {
          await event.reply(reply);
        } catch {
          // The action receipt is already recorded, so a reply failure must not retry it.
        }
      }
      return true;
    } finally {
      managedModerationPending.delete(key);
    }
  }

  async function handleManagedWhitelist(notice: MemberMuteNotice): Promise<void> {
    const registration = managedBlacklist;
    if (!registration || stopping || !handoff.accepting || dispatchPower.paused ||
        !groupDispatch.allowsGroupModeration(notice) || !groupDispatch.allows(notice, managedWhitelistNames)) return;
    const { self_id: bot, group_id: group, user_id: user, operator_id: operator, time, duration } = notice;
    const key = JSON.stringify([bot, group, user]);
    const previous = lastMemberMutes.get(key);
    if (previous && time < previous.time) return;
    const revisions = previous?.time === time ? previous.revisions : new Set<string>();
    const revision = JSON.stringify([operator, duration]);
    if (revisions.has(revision)) return;
    revisions.add(revision);
    const current = { time, revisions };
    lastMemberMutes.delete(key);
    if (lastMemberMutes.size >= 4096) lastMemberMutes.delete(lastMemberMutes.keys().next().value!);
    lastMemberMutes.set(key, current);
    const protectedOperator = () => operator === bot || masterPermissions.isMaster(bot, operator) ||
      masterPermissions.legacyMasterIds().includes(operator);
    if (!duration || user === bot || protectedOperator()) return;
    const signal = nativeOperationSignal(registration.signal, notice.signal);
    const expiresAt = Math.min(time * 1000, Date.now()) + duration * 1000;
    const active = () => !signal.aborted && lastMemberMutes.get(key) === current && Date.now() < expiresAt && !protectedOperator();
    const listed = () => registration.policy.shouldAutoUnmute(user).catch(() => false);
    if (!active() || !await listed() || !active() || !await notice.canModerate(signal) ||
        !active() || !await listed() || !active()) return;
    if (await notice.unmute(signal) === "confirmed" && !signal.aborted) {
      await notice.reply($t("app.text_a695fa0a1a"));
    }
  }

  async function handleGroupBannedWords(source: MessageEvent, text: string, alias: string | undefined,
    groupRules: boolean, screenedWords: boolean): Promise<boolean> {
    const registration = groupBannedWords;
    if (!registration || source.message_type !== "group" || source.isDelegated) return false;
    const { self_id: bot, group_id: group, user_id: user, message_id } = source;
    if (!bot || !group || !user || message_id === undefined) return false;
    const transport = groupModerationSession(source);
    if (!transport?.memberMessage || !transport.act) return false;
    const { memberMessage, act } = transport;
    const screenedText = screenedWords ? typeof source.message === "string" ? source.message : source.message
      .map(segment => segment.type === "text" ? segment.text : "").join("") : undefined;
    if (!text && !screenedText && !memberMessage.readImageMd5 && !memberMessage.mixedImageParts) return false;
    const signal = nativeOperationSignal(registration.signal, transport.signal);
    const active = () => !signal.aborted && bot !== user &&
      !masterPermissions.isMaster(bot, user) && !masterPermissions.legacyMasterIds().includes(user);
    if (!active()) return false;
    const key = moderatedMessageKey(source);
    if (moderatedMessages.has(key)) return true;
    let mayReadImage: Promise<boolean> | undefined;
    const protectImage = (read: (signal: AbortSignal) => Promise<string | undefined>) => {
      let value: Promise<string | undefined> | undefined;
      return (current: AbortSignal) => value ??= (async () => {
        if (!active() || !await (mayReadImage ??= memberMessage.canAct(current).catch(() => false)) || !active()) return;
        return read(current);
      })();
    };
    const mixed = memberMessage.mixedImageParts?.map((part, index) => {
      if (part.type === "image") return { ...part, readMd5: protectImage(part.readMd5) };
      if (part.type === "text" && index === 0 && alias && part.text.trimStart().startsWith(alias)) {
        return { ...part, text: part.text.trimStart().slice(alias.length) };
      }
      return part;
    });
    const afterAlias = !text && alias ? mixed?.filter(part => part.type !== "text" || part.text.trim()) : undefined;
    const singleImage = afterAlias?.length === 1 && afterAlias[0]?.type === "image" ? afterAlias[0].readMd5 : undefined;
    const readImage = !text && memberMessage.readImageMd5 ? protectImage(memberMessage.readImageMd5) : singleImage;
    const match = () => registration.policy.match(group, user, text, signal, readImage, mixed, { groupRules, screenedText }).catch(() => undefined);
    if (!await match() || !active() || !await memberMessage.canAct(signal).catch(() => false) || !active()) return false;
    const rule = await match();
    if (!rule || !active()) return false;
    if (moderatedMessages.has(key)) return true;
    if (moderatedMessages.size >= 4096) moderatedMessages.delete(moderatedMessages.values().next().value!);
    moderatedMessages.add(key);

    const receipts: string[] = [];
    async function apply(label: string, run: () => Promise<GroupModerationResult>) {
      const result = active() ? await run().catch(() => "unknown" as const) : "rejected";
      receipts.push(result === "confirmed" ? label : `${label}${result === "unknown" ? $t("app.text_e6bedaccc2") : $t("app.text_231fe22042")}`);
      return result === "confirmed";
    }
    const recall = () => apply($t("app.text_acd0006a55"), () => memberMessage.recall(signal));
    const screened = rule.screenedReply !== undefined;
    const recalled = screened && await recall();
    if (rule.action === "kick" || rule.action === "kick-recall" || rule.action === "kick-blacklist") {
      if (await apply($t("app.text_d5586c8693"), () => act(signal)) && rule.action === "kick-blacklist" && active()) {
        try {
          await registration.policy.recordConfirmedKick(user, signal, async () => active() && await memberMessage.botCanAct(signal) && active());
          receipts.push($t("app.text_010bbe20df"));
        } catch {
          receipts.push($t("app.text_fdf6ec9b1a"));
        }
      }
    }
    const muted = (rule.action === "mute" || rule.action === "mute-recall") && isMemberMuteDuration(rule.seconds) && rule.seconds > 0 &&
      await apply($t("app.text_b9f218c503", { "seconds": rule.seconds }), () => memberMessage.mute(rule.seconds, signal));
    if (!screened && (rule.action === "recall" || rule.action === "kick-recall" || rule.action === "mute-recall")) await recall();
    if (screened && recalled && muted) {
      if (active() && rule.screenedReply) {
        const reply = rule.screenedReply;
        await Promise.resolve().then(() => active() && source.reply(reply, false)).catch(() => {});
      }
      return true;
    }
    if (active() && receipts.length) {
      const nickname = source.sender?.card || source.sender?.nickname;
      const name = typeof nickname === "string" ? nickname.replace(/[\r\n]/gu, " ").trim().slice(0, 80) : "";
      const contact = name ? `${name}(${user})` : String(user);
      try {
        await source.reply($t("app.text_18f7a24f1b", { "preview": rule.preview, "contact": contact, "value3": receipts.join("、") }), false, { recallMsg: 30 });
      } catch {
        // A reply failure does not retry any moderation action.
      }
    }
    return true;
  }

  function moderatedMessageKey(source: MessageEvent): string {
    return JSON.stringify([source.adapter ?? "onebot", source.self_id, source.group_id, source.message_id]);
  }

  async function handleLeaveBlacklist(event: Exclude<BotEvent, MessageEvent>): Promise<boolean> {
    if (event.post_type === "notice" &&
        (event.notice_type !== "group" || (event.sub_type !== "increase" && event.sub_type !== "decrease"))) return false;
    const registration = leaveBlacklist;
    const notice = event.post_type === "notice" && event.notice_type === "group";
    if (!registration || (!notice && (event.post_type !== "request" || event.request_type !== "group" || event.sub_type !== "add")) ||
        !groupDispatch.allowsGroupModeration(event) ||
        !groupDispatch.allows(event, notice ? leaveBlacklistNoticeNames : leaveBlacklistRequestNames)) return false;
    const transport = groupModerationSession(event);
    if (!transport) return false;
    const active = nativeOperationSignal(registration.signal, transport.signal);
    const { self_id: botId, group_id: groupId, user_id: userId } = event;
    if (event.post_type === "notice") {
      return registration.policy.handle({
        kind: event.sub_type === "decrease" ? "leave" : "join", botId, groupId, userId,
        session: transport.signal, act: transport.act, time: event.time, operatorId: event.operator_id,
        name: event.member?.card || event.member?.nickname || event.nickname, dismissed: event.dismiss,
        id: event.time === undefined ? undefined : `${event.sub_type}:${groupId}:${userId}:${event.time}:${event.operator_id ?? ""}`,
      }, active);
    }
    return registration.policy.handle({
      kind: "apply", botId, groupId, userId, session: transport.signal, act: transport.act,
      id: `${event.groupRequestScope ?? "onebot"}:${event.flag}`,
    }, active);
  }

  function recordCount(direction: "receive" | "send", identity: { self_id?: number; user_id?: number; group_id?: number }, message?: unknown) {
    if (!counts.available()) return;
    const write = counts.record(direction, identity, message).catch(() => {});
    pendingCounts.add(write);
    void write.then(() => pendingCounts.delete(write));
  }

  async function handleEvent(event: BotEvent) {
    if (event.post_type === "message") {
      if ([event.msg, event.raw_message].some(isArkRankTokenCommand) || containsArkRankTokenInput(event.message) || isPanelTransferInput(event)) {
        return dispatchMessage(event);
      }
      const transport = event[friendMessageNoticeSession];
      if (transport && friendRecallNotice) {
        const capture = rememberFriendRecall(event, transport);
        if (capture) {
          pending.add(capture);
          void capture.then(() => pending.delete(capture));
        }
      }
      if (transport && friendMessageNotice) {
        const notice = forwardFriendMessage(event, transport).catch(() => {});
        pending.add(notice);
        void notice.then(() => pending.delete(notice));
      }
      return dispatchMessage(event);
    }
    if (event.post_type === "notice" && event.notice_type === "group" && event.sub_type === "increase") {
      await handleGroupVerificationNotice(event);
    }
    if (event.post_type === "notice" && event.notice_type === "friend" && event.sub_type === "poke") {
      const transport = event[friendMessageNoticeSession];
      if (friendPokeNotice && transport) {
        const notice = forwardFriendPoke(event, transport).catch(() => {});
        pending.add(notice);
        void notice.then(() => pending.delete(notice));
      }
      if (await privateAccess.blockedPoke(event, event.is_self_send)) return;
    }
    if (event.post_type === "notice" && event.notice_type === "friend" && event.sub_type === "poke_recall" &&
        !masterPermissions.isMaster(event.self_id, event.peer_id)) {
      await privateAccess.refresh();
      if (privateAccess.disabled) return;
    }
    if (event.post_type === "notice" && event.notice_type === "offline" &&
        !await privateAccess.allowsFileNotice(event.isMaster, event.file.name)) return;
    const allowed = (names: readonly string[]) => groupDispatch.allows(event, names);
    if (event.post_type === "request" && event.request_type === "group" && event.sub_type === "invite") {
      await dispatchGroupInvitation(event, allowed);
      return;
    }
    if (event.post_type === "request" && event.request_type === "group" && event.sub_type === "add" && allowed(groupAddNoticeNames)) {
      const registration = groupAddNotice;
      const transport = groupModerationSession(event);
      const authorize = transport?.canModerate;
      if (registration && transport && authorize) {
        const signal = nativeOperationSignal(registration.signal, transport.signal);
        const { sub_type, self_id, group_id, user_id, groupRequestScope, flag, nickname, comment, inviter_id } = event;
        if (!signal.aborted) await registration.policy.receive({
          sub_type, self_id, group_id, user_id, groupRequestScope, flag, nickname, comment, inviter_id, signal,
          async notifyGroup(parts) {
            if (signal.aborted || !await authorize(signal) || signal.aborted) return false;
            const origin = transport.joinRequestOrigin;
            return (await event.reply(parts, false, origin ? {
              async onDelivered(messageId) {
                if (!signal.aborted) await groupJoinReview.record(origin, messageId);
              },
            } : undefined)) === true;
          },
        }).catch(() => {});
      }
    }
    if (event.post_type === "request" && event.request_type === "friend") {
      const active = nativeOperationSignal();
      let reviewed = false;
      const consumed = await legacy.dispatch({
        ...event,
        approve(approve?: boolean, remark?: string) {
          reviewed = true;
          return event.approve(approve, remark);
        },
      }, allowed);
      if (reviewed || consumed || active.aborted) return;
      const canAutoApprove = () => groupDispatch.allowsInbound(event) && allowed(["autoFriend"]);
      const result = canAutoApprove() ? await autoFriend(event, active, canAutoApprove) : undefined;
      const registration = friendRequestNotice;
      if (result === "duplicate" || !registration || !event.notifyOwners || !allowed(friendRequestNoticeNames)) return;
      const signal = AbortSignal.any([active, registration.signal]);
      if (signal.aborted) return;
      const key = createHash("sha256").update(JSON.stringify([event.adapter ?? "onebot", event.self_id, event.flag])).digest("hex");
      if (notifiedFriendRequests.has(key)) return;
      const reply = await registration.policy({ botId: event.self_id, userId: event.user_id,
        nickname: event.nickname, source: event.source, comment: event.comment, autoResult: result }, signal);
      if (!reply || signal.aborted || notifiedFriendRequests.has(key)) return;
      notifiedFriendRequests.add(key);
      if (notifiedFriendRequests.size > 4096) notifiedFriendRequests.delete(notifiedFriendRequests.values().next().value!);
      await event.notifyOwners(reply, signal);
      return;
    }
    const dispatchedEvent = event.post_type === "request" && event.request_type === "group" && event.sub_type === "add"
      ? withGroupOwnerJoinNotice(event) : event;
    const consumed = await legacy.dispatch(dispatchedEvent, allowed);
    if (!consumed && event.post_type === "notice" && event.notice_type === "group" &&
        event.sub_type === "increase" && event.self_id === event.user_id && allowed(["notice"])) {
      const session = groupModerationSession(event)?.signal;
      if (session && await autoQuit(event, nativeOperationSignal(session))) {
        console.log($t("app.text_e412d32680", { "group_id": event.group_id }));
      }
    }
  }

  function canForwardPrivateNotice(botId: number, userId: number) {
    return botId !== userId && masterPermissions.masterIds(botId).length > 0 && !masterPermissions.isMaster(botId, userId) &&
      !masterPermissions.legacyMasterIds().includes(userId);
  }

  async function deliverPrivateNoticeOnce(key: string, deliver: (mark: () => void) => Promise<void>) {
    if (pendingPrivateNotices.has(key) || notifiedPrivateMessages.has(key)) return;
    pendingPrivateNotices.add(key);
    try {
      await deliver(() => {
        notifiedPrivateMessages.add(key);
        if (notifiedPrivateMessages.size > 4096) notifiedPrivateMessages.delete(notifiedPrivateMessages.values().next().value!);
      });
    } finally {
      pendingPrivateNotices.delete(key);
    }
  }

  function readMessageNoticeBody(message: MessageEvent["message"], signal: AbortSignal) {
    if (signal.aborted || typeof message === "string" || !message.length) return;
    const parts: (string | { sourceIndex: number })[] = [];
    for (const [sourceIndex, part] of message.entries()) {
      if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
      else if (part.type === "image" || part.type === "face") parts.push({ sourceIndex });
      else return;
    }
    const text = parts.filter(part => typeof part === "string").join("");
    if (isPrivateCredentialMessage(text)) return;
    const readParts = parts.some(part => typeof part !== "string") ? () => readFriendReplyParts(parts, message, signal) : undefined;
    return { text, readParts };
  }

  function originalNoticeMedia(message: MessageEvent["message"]) {
    const voice = standaloneVoicePart(message);
    if (voice) return {
      label: "[语音]", unavailable: $t("app.text_bea6ccc3d2"),
      async read(signal: AbortSignal): Promise<RecallMedia | undefined> {
        const file = await readOriginalQqVoice(voice, signal);
        if (file) return { type: "record", file };
      },
    };
    const video = standaloneVideoPart(message);
    if (video) return {
      label: "[视频]", unavailable: $t("app.text_2a4589fda6"),
      async read(signal: AbortSignal): Promise<RecallMedia | undefined> {
        const file = await readOriginalQqVideo(video, signal);
        if (file) return { type: "video", file };
      },
    };
  }

  async function forwardFriendMessage(event: MessageEvent, transport: FriendMessageNoticeSession) {
    const registration = friendMessageNotice;
    const { self_id: botId, user_id: userId, message_id: messageId, message, sender } = event;
    if (!registration || event.message_type !== "private" || event.sub_type !== "friend" || event.isDelegated || !botId || !userId ||
        messageId === undefined || !canForwardPrivateNotice(botId, userId) || !groupDispatch.allows(event, friendMessageNoticeNames)) return;
    const signal = nativeOperationSignal(registration.signal, transport.signal);
    const media = originalNoticeMedia(message);
    let followup: MessageReply | undefined;
    const body = media ? { async readParts() {
      followup = await media.read(signal);
      return [media.label + (followup ? "" : media.unavailable)];
    } } : readMessageNoticeBody(message, signal);
    if (!body) return;

    const peer = `${event.adapter ?? "onebot"}:${botId}:${userId}`;
    await deliverPrivateNoticeOnce(`friend:${peer}:${messageId}`, async mark => {
      const reply = await registration.policy({ botId, userId, ...body, canQuote: true,
        nickname: typeof sender?.nickname === "string" ? sender.nickname : undefined,
        async showHint() {
          if (signal.aborted) return false;
          const redis = globalThis.redis;
          if (redis) return await redis.set(`lotus-yunzai:friend-message-notice:hint:${peer}`, "1", { EX: 600, NX: true }) === "OK";
          const now = performance.now();
          if ((friendNoticeHints.get(peer) ?? 0) > now) return false;
          friendNoticeHints.delete(peer);
          friendNoticeHints.set(peer, now + 600_000);
          if (friendNoticeHints.size > 4096) friendNoticeHints.delete(friendNoticeHints.keys().next().value!);
          return true;
        },
      }, signal);
      if (!reply || signal.aborted) return;
      mark();
      const noticeText = reply.filter(part => typeof part === "string").join("");
      await transport.notifyOwners(reply, signal, async (owner, message) => {
        if (!signal.aborted && masterPermissions.isMaster(botId, owner)) {
          await friendNoticeReceipts.record({ adapter: event.adapter ?? "onebot", account: botId, owner, message }, userId, noticeText);
        }
      }, media ? { verifyRecipients: true, followup } : undefined);
    });
  }

  async function forwardTemporaryMessage(notice: NativeTemporaryMessageNotice) {
    const registration = temporaryMessageNotice;
    const { adapter, botId, userId, messageId, message, groupId, reportedGroupId } = notice;
    if (!registration || stopping || !handoff.accepting || !canForwardPrivateNotice(botId, userId)) return;
    const scope = { self_id: botId, user_id: userId, group_id: groupId };
    if (!groupDispatch.allowsInbound(scope) || !groupDispatch.allows(scope, temporaryMessageNoticeNames)) return;
    const signal = nativeOperationSignal(registration.signal, notice.signal);
    const media = originalNoticeMedia(message);
    const content = media ? undefined : readMessageNoticeBody(message, signal);
    if (signal.aborted || (!media && !content)) return;
    await deliverPrivateNoticeOnce(`temporary:${adapter}:${botId}:${userId}:${messageId}`, async mark => {
      let followup: MessageReply | undefined;
      const body = media ? { async readParts() {
        followup = await media.read(signal);
        return [media.label + (followup ? "" : media.unavailable)];
      } } : content;
      const reply = await registration.policy({ botId, userId, ...body, groupId, reportedGroupId }, signal);
      if (!reply || signal.aborted) return;
      mark();
      await notice.notifyOwners(reply, signal, followup);
    });
  }

  async function forwardFriendRelationship(notice: NativeFriendRelationshipNotice) {
    const registration = friendRelationshipNotice;
    const { botId, userId, time, kind } = notice;
    if (!registration || stopping || !handoff.accepting || !masterPermissions.masterIds(botId).length) return;
    const scope = { self_id: botId, user_id: userId };
    if (!groupDispatch.allowsInbound(scope) || !groupDispatch.allows(scope, friendRelationshipNoticeNames)) return;
    const signal = nativeOperationSignal(registration.signal, notice.signal);
    if (signal.aborted) return;
    await deliverPrivateNoticeOnce(`relationship:onebot:${botId}:${userId}:${kind}:${time}`, async mark => {
      const reply = await registration.policy({ botId, userId, kind, readNickname: () => notice.readNickname(signal) }, signal);
      if (!reply || signal.aborted) return;
      mark();
      await notice.notifyOwners(reply, signal);
    });
  }

  async function forwardFriendPoke(event: FriendPoke, transport: FriendMessageNoticeSession) {
    const registration = friendPokeNotice;
    const { self_id: botId, user_id: userId, time } = event;
    if (!registration || time === undefined || !masterPermissions.masterIds(botId).length || !groupDispatch.allows(event, friendPokeNoticeNames)) return;
    const signal = nativeOperationSignal(registration.signal, transport.signal);
    if (signal.aborted) return;
    await deliverPrivateNoticeOnce(`poke:${event.adapter ?? "onebot"}:${botId}:${userId}:${time}`, async mark => {
      const reply = await registration.policy({ botId, userId }, signal);
      if (!reply || signal.aborted) return;
      mark();
      await transport.notifyOwners(reply, signal);
    });
  }

  function rememberFriendRecall(event: MessageEvent, transport: FriendMessageNoticeSession) {
    const registration = friendRecallNotice;
    const { self_id: botId, user_id: userId, message_id: messageId, message } = event;
    if (!registration || event.message_type !== "private" || event.sub_type !== "friend" || event.isDelegated || !botId || !userId ||
        messageId === undefined || !canForwardPrivateNotice(botId, userId) || !groupDispatch.allows(event, friendRecallNoticeNames) ||
        typeof message === "string" || !message.length) return;
    const signal = nativeOperationSignal(registration.signal, transport.signal);
    const body = recallCaptureContent(message, signal);
    if (body === undefined || signal.aborted) return;
    return friendRecallCache.capture({ adapter: event.adapter ?? "onebot", botId, userId, messageId }, body,
      () => registration.policy.retention(botId, signal), signal);
  }

  function rememberGroupRecall(source: NativeGroupMessageSource) {
    const registration = groupRecallNotice;
    const { botId, userId, groupId, message } = source;
    const scope = { self_id: botId, user_id: userId, group_id: groupId };
    if (!registration || stopping || !handoff.accepting || !canForwardPrivateNotice(botId, userId) ||
        !groupDispatch.allowsInbound(scope) || !groupDispatch.allows(scope, groupRecallNoticeNames)) return;
    const signal = nativeOperationSignal(registration.signal, source.signal);
    if (signal.aborted) return;
    const body = recallCaptureContent(message, signal);
    if (body === undefined) return;
    return groupRecallCache.capture(source, body,
      () => registration.policy.retention(botId, groupId, signal), signal);
  }

  function recallCaptureContent(message: MessageEvent["message"], signal: AbortSignal) {
    const media = originalNoticeMedia(message);
    if (media) return () => readRecallMedia(signal, () => media.read(signal));
    const body = readRecallBody(message);
    if (body !== undefined) {
      if (!isPrivateCredentialMessage(recallNoticeInput(body).text)) return body;
      return;
    }
    if (typeof message === "string" || !message.some(part => part.type === "image")) return;
    const readParts = readMessageNoticeBody(message, signal)?.readParts;
    if (!readParts) return;
    return () => readRecallMedia(signal, readParts);
  }

  async function readRecallMedia(signal: AbortSignal, read: () => Promise<RecallBody | undefined>) {
    if (signal.aborted || activeRecallMediaReads >= 4) return;
    activeRecallMediaReads++;
    try {
      const body = await read();
      if (!signal.aborted) return body;
    } finally {
      activeRecallMediaReads--;
    }
  }

  function recallNoticeInput(body: RecallTextBody) {
    if (typeof body === "string") return { text: body };
    return { text: body.filter(part => typeof part === "string").join(""), parts: body };
  }

  async function forwardGroupMessageNotice(source: NativeGroupMessageSource) {
    const registration = groupMessageNotice;
    const { adapter, botId, groupId, userId, messageId, message, nickname } = source;
    if (!registration || !canForwardPrivateNotice(botId, userId)) return;
    const scope = { self_id: botId, group_id: groupId, user_id: userId };
    const signal = groupOwnerNotificationSignal(registration.signal, source.signal, scope, groupMessageNoticeNames);
    if (!signal) return;
    const media = originalNoticeMedia(message);
    const body = media ? { text: media.label } : readMessageNoticeBody(message, signal);
    if (!body) return;
    await deliverPrivateNoticeOnce(`group-message:${adapter}:${botId}:${groupId}:${userId}:${messageId}`, async mark => {
      const reply = await registration.policy({ botId, groupId, userId, ...body, nickname, describeGroup: () => source.describeGroup(signal) }, signal);
      if (!reply || signal.aborted) return;
      const followup = await media?.read(signal);
      if (signal.aborted) return;
      mark();
      const notice = media && !followup ? [...reply, media.unavailable] : reply;
      await source.notifyOwners(notice, signal, followup);
    });
  }

  async function forwardFriendRecall(notice: NativeFriendRecallNotice) {
    const registration = friendRecallNotice;
    const { botId, userId, time } = notice;
    if (!registration || stopping || !handoff.accepting || !canForwardPrivateNotice(botId, userId)) return;
    const scope = { self_id: botId, user_id: userId };
    if (!groupDispatch.allowsInbound(scope) || !groupDispatch.allows(scope, friendRecallNoticeNames)) return;
    const signal = nativeOperationSignal(registration.signal, notice.signal);
    if (signal.aborted || await registration.policy.retention(botId, signal) === undefined || signal.aborted) return;
    const body = await friendRecallCache.take(notice, signal);
    if (body === undefined || signal.aborted) return;
    if (isRecallMedia(body)) {
      const text = body.type === "record" ? "[语音]" : "[视频]";
      const summary = await registration.policy.format({ botId, userId, time, text }, signal);
      if (summary && !signal.aborted) await notice.notifyOwners(summary, signal, body);
    } else {
      const reply = await registration.policy.format({ botId, userId, time, ...recallNoticeInput(body) }, signal);
      if (reply && !signal.aborted) await notice.notifyOwners(reply, signal);
    }
  }

  async function forwardGroupRecall(notice: NativeGroupRecallNotice) {
    const registration = groupRecallNotice;
    const { botId, userId, groupId, operatorId, time } = notice;
    if (!registration || stopping || !handoff.accepting || operatorId === botId || !canForwardPrivateNotice(botId, userId)) return;
    const scope = { self_id: botId, user_id: userId, group_id: groupId };
    if (!groupDispatch.allowsInbound(scope) || !groupDispatch.allows(scope, groupRecallNoticeNames)) return;
    const signal = nativeOperationSignal(registration.signal, notice.signal);
    if (signal.aborted || await registration.policy.retention(botId, groupId, signal) === undefined || signal.aborted) return;
    const body = await groupRecallCache.take(notice, signal);
    if (body === undefined || signal.aborted) return;
    const description = await notice.describe(signal);
    if (signal.aborted) return;
    const details = { ...description, botId, userId, groupId, operatorId, time };
    if (isRecallMedia(body)) {
      const special = body.type === "record" ? "[语音]" : "[视频]";
      const reply = await registration.policy.format({ ...details, text: special, special }, signal);
      if (reply && !signal.aborted) {
        await notice.notifyOwners(reply.summary, reply.text, reply.nickname, signal, body);
      }
    } else {
      const reply = await registration.policy.format({ ...details, ...recallNoticeInput(body) }, signal);
      if (reply && !signal.aborted) await notice.notifyOwners(reply.summary, reply.parts ?? reply.text, reply.nickname, signal);
    }
  }

  function groupOwnerNotificationSignal(module: AbortSignal, transport: AbortSignal,
    scope: Pick<GroupNotice, "self_id" | "group_id" | "user_id">, names: readonly string[]) {
    if (stopping || !handoff.accepting || !masterPermissions.masterIds(scope.self_id).length ||
        !groupDispatch.allowsInbound(scope) || !groupDispatch.allows(scope, names)) return;
    const signal = nativeOperationSignal(module, transport);
    if (!signal.aborted) return signal;
  }

  async function forwardGroupOwnerMemberNotice(notice: NativeGroupOwnerMemberNotice) {
    const registration = groupOwnerMemberNotice;
    const { event } = notice;
    const { self_id: botId, group_id: groupId, user_id: userId, sub_type: direction, time } = event;
    if (!registration || time === undefined) return;
    const signal = groupOwnerNotificationSignal(registration.signal, notice.signal, event, groupOwnerMemberNoticeNames);
    if (!signal) return;
    await deliverPrivateNoticeOnce(`group-member:${notice.adapter}:${botId}:${groupId}:${userId}:${direction}:${time}`, async mark => {
      const reply = await registration.policy({ botId, groupId, userId, direction, time, dismiss: event.dismiss,
        action: event.action_sub_type, inviterId: event.inviter_id, describe: () => notice.describe(signal) }, signal);
      if (!reply || signal.aborted) return;
      mark();
      await notice.notifyOwners(reply, signal);
    });
  }

  async function forwardGroupOwnerAdminNotice(notice: NativeGroupOwnerAdminNotice) {
    const registration = groupOwnerAdminNotice;
    if (!registration) return;
    const { adapter, botId, groupId, userId, set, time } = notice;
    const scope = { self_id: botId, group_id: groupId, user_id: userId };
    const signal = groupOwnerNotificationSignal(registration.signal, notice.signal, scope, groupOwnerAdminNoticeNames);
    if (!signal) return;
    await deliverPrivateNoticeOnce(`group-admin:${adapter}:${botId}:${groupId}:${userId}:${set}:${time}`, async mark => {
      const reply = await registration.policy({ botId, groupId, userId, set }, signal);
      if (!reply || signal.aborted) return;
      mark();
      await notice.notifyOwners(reply, signal);
    });
  }

  async function forwardGroupOwnerBanNotice(notice: NativeGroupOwnerBanNotice) {
    const registration = groupOwnerBanNotice;
    if (!registration) return;
    const { adapter, botId, groupId, userId, operatorId, time, duration } = notice;
    const scope = { self_id: botId, group_id: groupId, user_id: userId };
    const signal = groupOwnerNotificationSignal(registration.signal, notice.signal, scope, groupOwnerBanNoticeNames);
    if (!signal) return;
    await deliverPrivateNoticeOnce(`group-ban:${adapter}:${botId}:${groupId}:${operatorId}:${duration}:${time}`, async mark => {
      const reply = await registration.policy({ botId, groupId, userId, operatorId, duration }, signal);
      if (!reply || signal.aborted) return;
      mark();
      await notice.notifyOwners(reply, signal);
    });
  }

  async function forwardGroupOwnerGroupNotice(notice: NativeGroupOwnerGroupNotice) {
    const registration = groupOwnerGroupNotice;
    if (!registration) return;
    const { adapter, botId, groupId, kind, operatorId, time } = notice;
    const scope = { self_id: botId, group_id: groupId, user_id: botId };
    const signal = groupOwnerNotificationSignal(registration.signal, notice.signal, scope, groupOwnerGroupNoticeNames);
    if (!signal) return;
    await deliverPrivateNoticeOnce(`group-list:${adapter}:${botId}:${groupId}:${kind}:${time}`, async mark => {
      const reply = await registration.policy({ botId, groupId, kind, operatorId, time, describe: () => notice.describe(signal) }, signal);
      if (!reply || signal.aborted) return;
      mark();
      await notice.notifyOwners(reply, signal);
    });
  }

  function withGroupOwnerJoinNotice(event: GroupRequest): GroupRequest {
    const registration = groupOwnerJoinRequestNotice;
    const { notifyOwners } = event;
    const session = groupModerationSession(event)?.signal;
    if (!registration || !notifyOwners || !session) return event;
    const signal = groupOwnerNotificationSignal(registration.signal, session, event, groupOwnerJoinRequestNoticeNames);
    if (!signal) return event;
    return {
      ...event,
      async notifyJoinRequestOwners(ordinary, actions) {
        if (signal.aborted) return 0;
        const reply = await registration.policy({ botId: event.self_id, groupId: event.group_id, userId: event.user_id,
          groupName: event.group_name, nickname: event.nickname, comment: event.comment }, signal).catch(() => undefined);
        if (signal.aborted) return 0;
        if (reply) return notifyOwners([...reply, `\n${actions}`], signal);
        return (event.notifyRequestOwners ?? event.notifyMasters)(ordinary);
      },
    };
  }

  function withGroupOwnerInvitationNotice(event: GroupRequest): GroupRequest {
    const registration = groupOwnerInvitationNotice;
    const { notifyOwners, notifyRequestOwners } = event;
    const session = groupModerationSession(event)?.signal;
    if (!registration || !notifyOwners || !session || masterPermissions.isMaster(event.self_id, event.user_id) ||
        masterPermissions.legacyMasterIds().includes(event.user_id)) return event;
    const signal = groupOwnerNotificationSignal(registration.signal, session, event, groupOwnerInvitationNoticeNames);
    if (!signal) return event;
    return {
      ...event,
      async notifyInvitationRequestOwners(ordinary, actions) {
        if (signal.aborted) return 0;
        const reply = await registration.policy({ botId: event.self_id, groupId: event.group_id, userId: event.user_id,
          groupName: event.group_name, nickname: event.nickname }, signal).catch(() => undefined);
        if (signal.aborted) return 0;
        if (!reply) return (notifyRequestOwners ?? event.notifyMasters)(ordinary);
        const content = [...reply, `\n${actions}`];
        if (!notifyRequestOwners) return notifyOwners(content, signal);
        const text = content.filter(part => typeof part === "string").join("");
        return notifyRequestOwners(text, { reply: content, signal });
      },
    };
  }

  async function dispatchGroupInvitation(event: GroupRequest, allowed: (names: readonly string[]) => boolean) {
    const session = groupModerationSession(event)?.signal;
    if (!session || !reviewInvitation.admits(event)) return;
    const active = nativeOperationSignal(session);
    if (active.aborted) return;
    let reviewed = false;
    let reviewManually: (() => Promise<void>) | undefined;
    const consumed = await legacy.dispatch({
      ...withGroupOwnerInvitationNotice(event),
      approve(approve?: boolean, reason?: string) {
        reviewed = true;
        return event.approve(approve, reason);
      },
      deferManualReview(review: () => Promise<void>) {
        reviewManually = review;
      },
    }, allowed);
    if (reviewed || consumed || active.aborted) return;

    const result = allowed(["invite"]) ? await reviewInvitation.review(event, active) : "skip";
    if (result === "skip" || result === "rejected") {
      if (!active.aborted) await reviewManually?.();
    } else if (result === "confirmed") {
      const group = event.group_name?.trim() || event.group_id;
      if (!active.aborted) await event.replyToApplicant?.($t("app.text_0d2fb8e9cb", { "group": group }));
    } else if (result === "unknown") {
      const delivered = active.aborted ? 0 : await event.notifyMasters($t("app.text_439ac3477b", { "group_id": event.group_id }));
      if (delivered === 0) console.warn($t("app.text_2d34206b83"));
    }
  }

  async function handleHostAccessList(event: MessageEvent, allowNew: boolean) {
    const command = hostAccessListCommand(event);
    if (!command) return false;
    if (event.isDelegated || event.attachmentOnly || !allowNew || stopping || !handoff.accepting || dispatchPower.paused ||
        !groupDispatch.allows(event, hostAccessListNames)) return true;

    const { adapter, self_id: botId, user_id: userId, sender, message_type } = event;
    const local = message_type === "terminal";
    const transport = event[delegationSession]?.signal;
    if (!local && (botId === undefined || userId === undefined || !transport || event.message_id === undefined ||
        (message_type === "private" && (event.sub_type !== "friend" || event.group_id !== undefined)) ||
        (sender?.user_id !== undefined && sender.user_id !== userId && sender.user_id !== String(userId)))) return true;
    const active = nativeOperationSignal(transport ?? lifecycle.signal);
    const isCurrent = () => !active.aborted && (local ? masterPermissions.terminal :
      canManagePackages(event) && (adapter !== "milky" || onlineMilkyBotId() === botId) &&
      masterPermissions.isMaster(botId!, userId!));
    if (!isCurrent()) return true;
    const { key, target, remove, label, currentGroup } = command;
    if (target === undefined) {
      await event.reply($t("app.text_8aa32457ba", { "label": label, "value2": key.endsWith("Group") ? $t("app.text_27c2162469") : $t("app.text_307af472d8") }));
      return true;
    }

    let message: string;
    try {
      const result = await updateHostAccessList(root, key, target, remove, local ? "stdin" : { botId: botId!, userId: userId! }, isCurrent);
      switch (result) {
        case "protected": message = $t("app.text_ec70728b95"); break;
        case "existing": message = $t("app.text_32c6e06ebd", { "target": target, "label": label }); break;
        case "missing": message = $t("app.text_77e925c9c6", { "target": target }); break;
        default:
          message = await Promise.all([groupDispatch.refreshLists(), otherPolicies.refresh(true)])
            .then(() => currentGroup ? $t("app.text_87ede9c81a", { "target": target, "label": label }) : $t("app.text_b16eeb203a", { "target": target, "label": label }))
            .catch(() => $t("app.text_52aa843c61"));
      }
    } catch {
      message = $t("app.text_2d93834b61", { "label": label });
    }
    if (isCurrent()) await event.reply(message);
    return true;
  }

  const remoteControl = createRemoteControl(fileURLToPath(root));
  const arkRankCredentials = createArkRankCredentialSettings({ signal: lifecycle.signal });
  let panelTransfer: PanelTransferAccess | undefined;

  function runQuotedRecall(incoming: MessageEvent, active: () => boolean, imageMessageOnly = false) {
    const quoted = quotedRecallSessions.get(incoming);
    if (!quoted) return;
    const route = { self_id: quoted.account, user_id: quoted.actor, group_id: quoted.group };
    return quoted.run({
      imageMessageOnly,
      active: () => active() && groupDispatch.allowsInbound(route) && groupDispatch.allows(route, recallFeatureNames),
      async authorize(botMessage, readRole) {
        if (quoted.group === undefined) return true;
        const isMaster = () => masterPermissions.isMaster(quoted.account, quoted.actor);
        const role = isMaster() ? undefined : await readRole();
        const settings = await readGroupRecallPermissions(root);
        if (!settings) return $t("app.text_77e58bebc7");
        return groupRecallPermission(settings[botMessage ? "bot" : "member"], isMaster(), role);
      },
    });
  }

  async function replyBotOperation(event: MessageEvent, target: number | undefined, allowNew: boolean) {
    if (!allowNew || dispatchPower.paused || stopping || !handoff.accepting || event.isDelegated || event.attachmentOnly ||
        !groupDispatch.allows(event, ["botOperate", $t("app.text_d0dc300c07"), "system", "@lotus-yunzai/system"])) return;
    const { self_id: botId, user_id: actorId, sender, message_type, adapter } = event;
    const transport = event[delegationSession]?.signal;
    if (botId === undefined || actorId === undefined || !transport || event.message_id === undefined ||
        (message_type === "group" ? event.group_id === undefined || event.sub_type === "anonymous"
          : message_type !== "private" || event.sub_type !== "friend" || event.group_id !== undefined) ||
        (sender?.user_id !== undefined && sender.user_id !== actorId && sender.user_id !== String(actorId))) return;
    const signal = nativeOperationSignal(transport);
    if (signal.aborted) return;
    const oneBot = groups.onlineBots();
    const milky = onlineMilkyBotId();
    if (!(adapter === "milky" ? milky === botId : oneBot.includes(botId))) return;
    if (!canManagePackages(event) || !masterPermissions.isMaster(botId, actorId)) {
      await event.reply($t("app.text_8e0ddab11a"));
    } else if (target === undefined || (target !== milky && !oneBot.includes(target))) {
      await event.reply($t("app.text_1d80cac526"));
    } else if (target !== botId) {
      await event.reply($t("app.text_8561a6b11f"));
    } else {
      await event.reply($t("app.text_5751f41a51"));
    }
  }

  async function isCompactGenshinShowcase(message: string) {
    if (!/^#更新\S/u.test(message) || !isUpdateCommand(message)) return false;
    try {
      const { matchGenshinShowcase } = await import("./plugins/genshin/panel/showcase-command.ts");
      const intent = matchGenshinShowcase(message);
      if (typeof intent !== "object" || !intent.characterName) return false;
      const { resolveGenshinCharacter } = await import("./plugins/genshin/rank-statistics/stats.ts");
      return !!await resolveGenshinCharacter(intent.characterName);
    } catch {
      return false;
    }
  }

  async function dispatchMessage(incoming: MessageEvent, handled?: () => void) {
    if (isGameSignatureInput(incoming)) return;
    incoming = quietDeliveryNotices(incoming);
    let prepared = groupDispatch.prepare(incoming);
    const { event, allowNew } = prepared;
    const scope = allowNew && event.msg ? ownCheckinSession(event, []) : undefined;
    if (scope && event.message_type === "group") {
      const command = normalizeGameCommand(event).msg;
      const personal = isPassportLoginInput(event.msg) || isDeviceBindingInput(command) || isDeviceBindingPayload(event.msg) ||
        isDeviceBindingPayload(event.raw_message) || !!matchOwnRoleSelection(command) || !!matchArkSelfRank(event.msg) ||
        !!matchGameProfileCommand(command) || matchRetiredUidCommand(command) || !!matchPublicUidQuery(command) ||
        (!!matchPanelSignatureCommand(event.msg) && matchPanelSignatureCommand(event.msg)?.action !== "export") ||
        /^#?(?:原神)?(?:留影(?:叙佳期)?|领?(?:角色)?生日卡?)(?:\s|$)/u.test(command) ||
        /^(?:#?(?:星铁|星穹铁道|星轨|穹轨|星穹|崩铁|铁道)|[*＊])\s*(?:(?:本期|上期)?(?:模拟)?宇宙|(?:寰宇)?蝗灾|差分|(?:常规|本期|上期|本周|上周|周期)(?:差分|演算))/u.test(command) ||
        /^#?(?:原神|星铁|绝区零)?(?:刷新)?(?:我的)?(?:原神|星铁|绝区零)?注册时间$/u.test(command) ||
        /^(?:#原神|#)?幽境群榜(?:授权|确认|撤回)/u.test(command) ||
        /^#绝区零(?:(?:card|卡片|个人信息|角色)\s*|(?:刷新|更新)?(?:月报|菲林月报|绳网月报))/iu.test(command);
      const wrapped = personal ? withGroupPersonalReplies(event, scope.isCurrent) : event;
      prepared = { ...prepared, event: { ...wrapped,
        verifyOwnGroupMembership: async (group, signal) => {
          if (group !== event.group_id || signal.aborted || !scope.isCurrent() || !event.listCurrentGroupMembers) return false;
          const members = await event.listCurrentGroupMembers().catch(() => undefined);
          return !signal.aborted && scope.isCurrent() && !!members?.some(member => member.id === scope.user);
        },
      } };
    }
    const dispatch = () => dispatchPreparedMessage(incoming, prepared, handled);
    if (!scope) return withGameCommandProfiles(undefined, dispatch);
    const profiles = await gameProfileDefaults.read(String(scope.user));
    let handling = true;
    try {
      return await withGameCommandProfiles({ user: scope.user, profiles, isCurrent: () => handling && scope.isCurrent() }, dispatch);
    } finally {
      handling = false;
    }
  }

  async function dispatchPreparedMessage(incoming: MessageEvent, { event, allowNew, alias }: ReturnType<typeof groupDispatch.prepare>,
    handled?: () => void) {
    const botOperation = botOperationCommand(event.msg);
    if (botOperation) {
      await replyBotOperation(event, botOperation.target, allowNew);
      return;
    }
    const allowed = (names: readonly string[]) => groupDispatch.allows(event, names);
    const transfer = matchPanelTransferCommand(event.msg);
    const transferCapability = isPanelTransferInput(event);
    if (transfer || transferCapability) {
      if (!allowNew || dispatchPower.paused || event.isDelegated || event.attachmentOnly || !transfer) return;
      const module = transfer.game === "gs" ? "@lotus-yunzai/genshin" : "@lotus-yunzai/starrail";
      if (!allowed([$t("app.text_d75ddb785b"), module])) return;
      const connection = event.privateCredentialSignal;
      if (event.message_type !== "private" || event.sub_type !== "friend" || !connection) {
        if (event.message_type === "group" && !transferCapability) {
          await event.reply($t("app.text_6648a2a4ac"));
        }
        return;
      }
      const signal = nativeOperationSignal(connection);
      if (signal.aborted || await privateAccess.blocked(event)) return;
      const protectedEvent = { ...event, privateCredentialSignal: signal };
      const reply = await commands.dispatchFallback(protectedEvent, names => allowed(names),
        user => event.self_id !== undefined && masterPermissions.isMaster(event.self_id, user),
        event.msg, { panelTransfer }, module);
      if (reply !== undefined && !signal.aborted) await sendCommandReply(protectedEvent, reply);
      return;
    }
    const rankCredentialCommand = [event.msg, event.raw_message].find(isArkRankTokenCommand);
    if (rankCredentialCommand !== undefined) {
      if (!allowNew || dispatchPower.paused || event.isDelegated || event.attachmentOnly ||
          !allowed([$t("app.text_7818bb7cc0"), "@lotus-yunzai/genshin", "@lotus-yunzai/starrail"])) return;
      const connection = event.privateCredentialSignal;
      const isBotMaster = (userId: number) => event.self_id !== undefined && masterPermissions.isMaster(event.self_id, userId);
      const reply = await arkRankCredentials.command(rankCredentialCommand, {
        ...event, normalizedMessage: event.msg, isBotMaster,
        privateCredentialSignal: connection && nativeOperationSignal(connection),
      });
      if (reply !== undefined && !connection?.aborted) await sendCommandReply(event, reply);
      return;
    }
    if (containsArkRankTokenInput(event.message)) return;
    if ([event.msg, event.raw_message].some(isRemoteControlCommand)) {
      const transport = event.privateCredentialSignal;
      const { self_id: botId, user_id: actorId, sender } = event;
      if (!allowNew || !transport || event.isDelegated || event.attachmentOnly || dispatchPower.paused ||
          event.message_type !== "private" || event.sub_type !== "friend" || event.group_id !== undefined ||
          botId === undefined || actorId === undefined || event.message_id === undefined ||
          (sender?.user_id !== undefined && sender.user_id !== actorId && sender.user_id !== String(actorId))) return;
      const signal = nativeOperationSignal(transport);
      const current = () => !signal.aborted && !stopping && handoff.accepting &&
        allowed([$t("app.text_42db987eee"), "system", "@lotus-yunzai/system"]) && canManagePackages(event) &&
        (event.adapter !== "milky" || onlineMilkyBotId() === botId) && masterPermissions.isMaster(botId, actorId);
      if (current()) await remoteControl(event, {
        signal, current,
        async allowed(permission) {
          const policy = await readLotusGlobalConfig(root).then(config => accountScopePermission(config, permission)).catch(() => undefined);
          return current() && policy?.({ user_id: actorId, isMaster: true }) === true;
        },
      });
      return;
    }
    const atlasCommand = atlasMaintenanceCommand.test(event.msg);
    const updateCheck = isUpdateCheckCommand(event.msg);
    const updateNoticeChange = updateNoticeSettingCommand(event.msg);
    if (event.msg === "#TodayEatPro20x" && (event.isDelegated || !canManagePackages(event) ||
        (event.message_type !== "terminal" && (event.message_type !== "private" || event.sub_type !== "friend" ||
          event[delegationSession]?.signal.aborted !== false)))) return;
    if (event.isDelegated && (dispatchPower.paused || matchesMasterEnrollment(event.msg) ||
        (await import("./plugins/execute/index.ts")).isNestedExecution(event.msg) ||
        /^#(?:开机|关机|关机模式|重启|停机|停止|更新群名片)(?:\s|$)/u.test(event.msg) ||
        atlasCommand || updateCheck || updateNoticeChange || isUpdateCommand(event.msg) || isInstallCommand(event.msg) || isLogCommand(event.msg) ||
        isLogLevelCommand(event.msg) || isRecallCommand(event) ||
        isAccountLoginMutation(event.msg) || matchesAccountCookieStatus(event.msg) ||
        isMiyousheWebCommand(event.msg) || isPreviewRedeemSetting(event.msg) || isManualRedeemCommand(event.msg) ||
        zzzLinkEntry.test(event.msg) || starRailLinkEntry.test(event.msg) ||
        /^(?:#?取消$|#批量刷新签到(?:\s|$))/u.test(event.msg) ||
        [event.msg, event.raw_message].some(value => isCloudTokenInput(value) || isHoYoLabCookieInput(value) ||
          isPassportLoginInput(value) || isDeviceBindingInput(value) || isZzzGachaLinkMessage(value) || isStarRailGachaLinkMessage(value)))) return;
    if (dispatchPower.paused) {
      if (allowNew && event.msg === "#开机" && allowed([$t("app.text_da4ea0ec27"), "system", systemModuleName])) {
        await dispatchPower.handle(event);
      }
      return;
    }
    if (leaveBlacklist?.policy.matchesCommand(event.msg) && event.message_type === "group" && event.group_id !== undefined &&
        !event.isDelegated && allowNew && allowed(leaveBlacklistManageNames)) {
      const transport = event[delegationSession]?.signal;
      const { self_id, user_id } = event;
      if (!transport || self_id === undefined || user_id === undefined || !masterPermissions.isMaster(self_id, user_id)) return;
      const active = nativeOperationSignal(leaveBlacklist.signal, transport);
      const reply = await leaveBlacklist.policy.manage(event.msg, { groupId: event.group_id, signal: active }, active);
      if (reply !== undefined && !active.aborted) await event.reply(reply);
      return;
    }
    if (allowNew && event.msg === "#关机" && allowed(processFeatureNames)) {
      if (isProcessMaster(event)) await dispatchPower.handle(event);
      else await event.reply($t("app.text_ee7b348d1b"));
      return;
    }
    if (allowNew && /^#(?:重启|停机|停止)$/u.test(event.msg) && allowed(processFeatureNames)) {
      await controlProcess(event, event.msg === "#重启" ? "restart" : "stop");
      return;
    }
    if (matchesMasterEnrollment(event.msg)) {
      if (allowNew && allowed([$t("app.text_f5cb6168cc"), "system", "@lotus-yunzai/system"])) await masterEnrollment(event);
      return;
    }
    const namedShowcase = allowNew && await isCompactGenshinShowcase(event.msg);
    if (event.message_type === "private" && isMilkyOwnerSession(event)) {
      await privateAccess.refresh();
      if (privateAccess.disabled) {
        if (updateCheck) {
          if (allowNew && allowed(updateFeatureNames)) await checkForUpdate(event);
          return;
        }
        if (updateNoticeChange) {
          if (allowNew && allowed(updateFeatureNames)) await configureUpdateNotice(event, updateNoticeChange);
          return;
        }
        if (!namedShowcase && hasValidUpdateTarget(event.msg)) {
          if (allowNew && allowed(updateFeatureNames)) await updateCommand(event);
          return;
        }
        if (hasValidInstallTarget(event.msg)) {
          if (allowNew && allowed(installFeatureNames)) await installCommand(event);
          return;
        }
      }
    }
    const statusCard = /^#状态(?:[Pp]ro)?$/u.test(event.msg);
    const bareStatus = /^状态(?:[Pp]ro)?$/u.test(event.msg);
    const statusMonitor = event.msg === "#监控";
    const originalPictureCommand = event.lookupReply !== undefined && event.reply_id !== undefined && !event.isDelegated
      ? normalizeOriginalPictureCommand(event.msg) : event.msg;
    const statusPhoto = /^#?(?:原神)?原图$/u.test(originalPictureCommand) && event.lookupReply !== undefined &&
      (event.listCurrentGroupMembers !== undefined || event.privateCredentialSignal?.aborted === false);
    const milky = event.adapter === "milky" && event.self_id !== undefined && onlineMilkyBotId() === event.self_id;
    const atlasMaintenance = atlasCommand && canManagePackages(event) && (event.adapter !== "milky" || milky) ? true as const : undefined;
    const milkyDiagnostics = milky && event.message_type === "private" &&
      (event.msg === "#诊断" || statusCard || (bareStatus && /[Pp]ro$/u.test(event.msg))) && isMilkyOwnerSession(event);
    const runtimeStatusScope = (statusCard || bareStatus || statusPhoto || statusMonitor) && !event.isDelegated ?
      event.message_type === "terminal" && event.isMaster ? "terminal" : milky ? "milky" : event.boundAccount ? "onebot" : undefined : undefined;
    const originalMessage = [event.msg, event.raw_message];
    const gameAccountCommand = normalizeGameCommand(event).msg;
    const protectedModule = originalMessage.some(isCloudTokenInput) ? "@lotus-yunzai/cloud-profile"
      : originalMessage.some(isHoYoLabCookieInput) ? "@lotus-yunzai/hoyolab-profile" : isPassportLoginInput(event.msg) ? "@lotus-yunzai/passport-login"
      : isDeviceBindingInput(event.msg) || isDeviceBindingInput(gameAccountCommand) || isDeviceBindingPayload(event.msg) || isDeviceBindingPayload(event.raw_message) ? "@lotus-yunzai/device" : undefined;
    if (protectedModule) {
      if (allowNew) {
        const connection = protectedModule === "@lotus-yunzai/passport-login" ? event.privateCredentialSignal : undefined;
        const protectedEvent = connection ? { ...event, privateCredentialSignal: nativeOperationSignal(connection) } : event;
        const protectedCommand = protectedModule === "@lotus-yunzai/device" ? gameAccountCommand : event.msg;
        const reply = await commands.dispatchFallback(protectedEvent, (names) => names[0] === protectedModule && allowed(names),
          (userId) => event.self_id !== undefined && masterPermissions.isMaster(event.self_id, userId), protectedCommand);
        if (reply !== undefined) await sendCommandReply(event, reply);
      }
      return;
    }
    const tuningLink = isZzzGachaLinkMessage(event.msg);
    const tuningLinkEntry = zzzLinkEntry.test(event.msg);
    if (tuningLink || tuningLinkEntry || (event.isPrivate && event.msg.trim() === "取消")) {
      // Give credential-bearing links only to the native handler, before V3 contexts and other fallbacks.
      if (allowNew && (event.isPrivate || tuningLinkEntry)) {
        const reply = await commands.dispatchFallback(event, (names) => names[0] === "@lotus-yunzai/zzz" && allowed(names),
          (userId) => event.self_id !== undefined && masterPermissions.isMaster(event.self_id, userId),
          tuningLinkEntry ? event.msg.replace(zzzLinkEntry, "#绝区零$1") : event.msg);
        if (reply !== undefined) {
          await sendCommandReply(event, reply);
          return;
        }
      }
      if (tuningLink || tuningLinkEntry) return;
    }
    const warpLink = originalMessage.find(isStarRailGachaLinkMessage);
    const warpLinkEntry = starRailLinkEntry.test(event.msg);
    if (warpLink || warpLinkEntry || (event.isPrivate && event.msg.trim() === "取消")) {
      if (allowNew && (event.isPrivate || warpLinkEntry)) {
        const reply = await commands.dispatchFallback(event, (names) => names[0] === "@lotus-yunzai/starrail" && allowed(names),
          (userId) => event.self_id !== undefined && masterPermissions.isMaster(event.self_id, userId), warpLink ?? event.msg);
        if (reply !== undefined) {
          await sendCommandReply(event, reply);
          return;
        }
      }
      if (warpLink || warpLinkEntry) return;
    }
    const paymentLink = originalMessage.find(isGenshinPayLogLinkCandidate);
    if (paymentLink) {
      const connection = event.privateCredentialSignal;
      if (allowNew && event.isPrivate && !event.isDelegated && connection?.aborted === false) {
        const protectedEvent = { ...event, privateCredentialSignal: nativeOperationSignal(connection) };
        const reply = await commands.dispatchFallback(protectedEvent, names => names[0] === "@lotus-yunzai/genshin" && allowed(names),
          user => event.self_id !== undefined && masterPermissions.isMaster(event.self_id, user), paymentLink, undefined, "@lotus-yunzai/genshin");
        if (reply !== undefined) await sendCommandReply(protectedEvent, reply);
      }
      return;
    }
    if (event.isPrivate && event.msg.trim() === "取消") {
      const reply = await commands.dispatchFallback(event, (names) => names[0] === "@lotus-yunzai/device" && allowed(names),
        (userId) => event.self_id !== undefined && masterPermissions.isMaster(event.self_id, userId));
      if (reply !== undefined) {
        await sendCommandReply(event, reply);
        return;
      }
    }
    if (await privateAccess.blocked(event)) return;
    const recoveryConfirmation = matchLegacyPanelRecoveryConfirmation(event.msg);
    if (recoveryConfirmation) {
      const features = panelSignatureFeatures[recoveryConfirmation.game];
      if (!allowNew || event.isDelegated || event.attachmentOnly || !allowed(features)) return;
      const scope = ownCheckinSession(event, features);
      if (!scope?.privateFriend || event.self_id === undefined) {
        await event.reply($t("app.text_c3db011d9c"));
        return;
      }
      const session = { ...scope, bot: event.self_id, adapter: event.adapter === "milky" ? "milky" as const : "onebot" as const };
      const reply = await legacyPanelRecovery.confirm(recoveryConfirmation, session);
      if (reply !== undefined && scope.isCurrent()) await sendCommandReply(event, reply);
      return;
    }
    if (matchesAccountCookieStatus(gameAccountCommand)) {
      const features = accountCookieStatusFeatures;
      const scope = allowNew && allowed(features) ? ownCheckinSession(event, features) : undefined;
      if (!scope?.privateFriend) return;
      const reply = await accountCookieStatus(scope);
      if (reply !== undefined && scope.isCurrent()) await event.reply(reply);
      return;
    }
    const profileCommand = matchGameProfileCommand(gameAccountCommand);
    if (profileCommand) {
      if (!allowNew || event.isDelegated || event.attachmentOnly || !allowed(ownRoleSelectionFeatures)) return;
      const scope = ownCheckinSession(event, ownRoleSelectionFeatures);
      if (!scope) return;
      const reply = await gameProfileCommands(profileCommand, scope);
      if (reply !== undefined && scope.isCurrent()) await sendCommandReply(event, reply);
      return;
    }
    if (matchRetiredUidCommand(gameAccountCommand)) {
      if (allowNew && !event.isDelegated && !event.attachmentOnly && allowed(ownRoleSelectionFeatures) && ownCheckinSession(event, ownRoleSelectionFeatures)) {
        await event.reply($t("lib.uid-commands.retired"));
      }
      return;
    }
    const publicUidCommand = matchPublicUidQuery(gameAccountCommand);
    if (publicUidCommand) {
      if (!allowNew || event.isDelegated || event.attachmentOnly || !allowed(ownRoleSelectionFeatures)) return;
      const scope = ownCheckinSession(event, ownRoleSelectionFeatures);
      if (!scope) return;
      const reply = await publicUidQuery(publicUidCommand, scope);
      if (reply !== undefined && scope.isCurrent()) await sendCommandReply(event, reply);
      return;
    }
    const gameLoginRemoval = matchGameLoginRemoval(gameAccountCommand);
    if (gameLoginRemoval) {
      const features = ["@lotus-yunzai/account"];
      if (!allowNew || event.isDelegated || event.attachmentOnly || !allowed(features)) return;
      const scope = ownCheckinSession(event, features);
      if (!scope?.privateFriend) {
        if (event.message_type === "group" && scope) await event.reply($t("app.text_d794af059d"));
        return;
      }
      const reply = await removeSelectedGameLogin(roleProfiles, gameLoginRemoval, scope);
      if (reply !== undefined && scope.isCurrent()) await sendCommandReply(event, reply);
      return;
    }
    const ownRoleSelection = matchOwnRoleSelection(gameAccountCommand);
    if (ownRoleSelection) {
      if (!allowNew || event.isDelegated || event.attachmentOnly || !allowed(ownRoleSelectionFeatures)) return;
      const scope = ownCheckinSession(event, ownRoleSelectionFeatures);
      if (!scope) return;
      const reply = await selectOwnRole(roleProfiles, ownRoleSelection, scope,
        createOwnRoleLegacyArtwork(roleProfiles, lockFile));
      if (reply !== undefined && scope.isCurrent()) await sendCommandReply(event, reply);
      return;
    }
    const panelSignature = matchPanelSignatureCommand(event.msg);
    if (panelSignature) {
      const features = panelSignatureFeatures[panelSignature.game];
      if (!allowNew || event.isDelegated || event.attachmentOnly || !allowed(features)) return;
      const scope = ownCheckinSession(event, features);
      if (!scope || event.self_id === undefined || (panelSignature.action === "export" && !scope.privateFriend)) {
        await event.reply($t("app.text_bdae5bcc73"));
        return;
      }
      const session = { ...scope, bot: event.self_id, adapter: event.adapter === "milky" ? "milky" as const : "onebot" as const };
      const { game } = panelSignature;
      if (panelSignature.action !== "export") {
        await event.reply($t("lib.uid-commands.retired"));
        return;
      }
      const uid = panelSignature.uid!;
      const authorized = await ownedPanelAuthorization(roleProfiles, game, uid, gameCommandProfileId(game), scope);
      if (!scope.isCurrent()) return;
      if (!authorized) {
        await event.reply($t("app.profile-owned-export"));
        return;
      }
      const reply = await exportOwnedPanel(game, uid, authorized, event, session.signal);
      if (reply !== undefined && scope.isCurrent()) await sendCommandReply(event, reply);
      return;
    }
    const selfRank = matchArkSelfRank(event.msg);
    if (selfRank) {
      const features = arkSelfRankFeatures[selfRank.game];
      if (!allowNew || event.isDelegated || event.attachmentOnly || !allowed(features)) return;
      const scope = ownCheckinSession(event, features);
      const reply = await arkSelfRank(selfRank, scope);
      for (const part of typeof reply === "string" ? [reply] : reply ?? []) {
        if (scope && !scope.isCurrent()) break;
        await event.reply(part);
      }
      handled?.();
      return;
    }
    if (await ownerMessageRelay.handle(event, {
      allowNew, signal: nativeOperationSignal(),
      allowed: () => allowsOwnerRelay(event),
    })) return;
    if (event[chatFileRelaySource]?.relayOnly) return;
    if (isLogLevelCommand(event.msg)) {
      if (allowNew && allowed([$t("app.text_0f8effe393"), "system", systemModuleName])) await setRuntimeLogLevel(event);
      return;
    }
    const setting = chatSetting(event.msg);
    if (setting) {
      if (!allowNew || !plugins || !allowed(chatSettingsNames) || event.attachmentOnly) return;
      const terminal = event.message_type === "terminal";
      const session = event[delegationSession]?.signal;
      const signal = session ? nativeOperationSignal(session) : nativeOperationSignal();
      const canWrite = () => !signal.aborted && !stopping && handoff.accepting && !event.isDelegated &&
        canManagePackages(event) && groupDispatch.allowsInbound(event) && allowed(chatSettingsNames) &&
        (terminal ? masterPermissions.terminal : session?.aborted === false && event.self_id !== undefined &&
          event.user_id !== undefined && masterPermissions.isMaster(event.self_id, event.user_id));
      chatSettings ??= createChatSettings(root, plugins.directories);
      const reply = await chatSettings(setting, canWrite, signal, !terminal);
      if (reply !== undefined && !signal.aborted) await event.reply(reply);
      return;
    }
    if (event.attachmentOnly || (!allowNew && event.attachment && !event.msg)) {
      if (event.attachment) {
        const { self_id } = event;
        const reply = await commands.dispatchFallback(event, allowed, (userId) =>
          self_id !== undefined && masterPermissions.isMaster(self_id, userId));
        if (reply !== undefined) await sendCommandReply(event, reply);
      }
      if (allowNew && event.attachmentOnly && event[chatFileRelaySource]?.notice) {
        await legacy.dispatch(event, allowed, undefined, { externalOnly: true });
      }
      return;
    }
    const avatar = qqAvatarCommand(event.msg);
    if (avatar) {
      if (allowNew && allowed([avatar.group ? $t("app.text_9352fee677") : $t("app.text_3ea2d23c90"), "group", "@lotus-yunzai/group"])) {
        const reply = qqAvatarReply(event, avatar);
        if (reply !== undefined) await event.reply(reply, true);
      }
      return;
    }
    if (isQqFaceCommand(event.msg)) {
      if (allowNew && allowed([$t("app.text_be7f15d660"), "group", "@lotus-yunzai/group"])) {
        const reply = qqFaceReply(event);
        if (reply !== undefined) await sendCommandReply(event, reply);
      }
      return;
    }
    const canReadChatImages = () => groupDispatch.allowsInbound(event) && allowed([$t("app.text_549bd77375"), "group", "@lotus-yunzai/group"]);
    if (allowNew && await quotedImageTools(event, nativeOperationSignal, canReadChatImages,
      active => runQuotedRecall(incoming, active, true) ?? Promise.resolve(undefined))) return;
    if (await chatMediaLinks(event, nativeOperationSignal, allowNew, canReadChatImages)) return;
    const groupToLeave = manualGroupLeaveInput(event.msg);
    if (groupToLeave !== undefined) {
      const allowedToLeave = () => groupDispatch.allowsInbound(event) && allowed([$t("app.text_78ab4c03df"), "group", "@lotus-yunzai/group"]);
      if (allowNew && allowedToLeave()) await leaveGroup(event, groupToLeave, allowedToLeave, nativeOperationSignal());
      return;
    }
    if (await handleHostAccessList(event, allowNew)) return;
    const contactList = ownerContactListCommand(event.msg);
    if (contactList) {
      if (allowNew && allowed([$t("app.text_b7bfc0a2e9", { "kind": contactList.kind }), "group", "@lotus-yunzai/group"])) {
        await replyOwnerContactList(event, contactList, ownerMessageRelay);
      }
      return;
    }
    const cloudWallet = cloudWalletProfile(incoming.msg);
    if (cloudWallet !== undefined) {
      const features = [$t("app.text_b0bbedb4e0"), "@lotus-yunzai/cloud-profile"];
      if (!allowNew || event.isDelegated || event.attachmentOnly || !allowed(features)) return;
      const { user_id: user, self_id: bot, group_id: groupId, sender } = event;
      const group = event.message_type === "group" && event.sub_type !== "anonymous" && groupId !== undefined && groupId > 0;
      const privateFriend = event.message_type === "private" && event.sub_type === "friend";
      const connection = group ? event[delegationSession]?.signal : privateFriend ? event.privateCredentialSignal : undefined;
      if (!connection || connection.aborted || user === undefined || !Number.isSafeInteger(user) || user < 1 ||
          bot === undefined || event.message_id === undefined ||
          (sender?.user_id !== undefined && sender.user_id !== user && sender.user_id !== String(user))) return;
      const signal = nativeOperationSignal(connection);
      const reply = cloudWallet === null ? $t("app.text_3dd62228d2") : await cloudGenshinWallet?.(user, cloudWallet, signal);
      if (reply !== undefined && !signal.aborted && allowed(features)) {
        await event.reply(group ? [segment.at(user), "\n" + reply] : reply);
      }
      return;
    }
    const balanceProfile = miyousheBalanceProfile(event.msg);
    if (balanceProfile !== undefined) {
      const features = [$t("app.text_36f7831bca"), $t("app.text_bd73de9617"), "account", "@lotus-yunzai/account"];
      const connection = event[delegationSession]?.signal;
      const user = event.user_id;
      const group = event.message_type === "group" && event.sub_type !== "anonymous";
      const privateFriend = event.message_type === "private" && event.sub_type === "friend";
      if (allowNew && connection && !event.isDelegated && (group || privateFriend) &&
          user !== undefined && Number.isSafeInteger(user) && user > 0 &&
          allowed(features)) {
        const signal = nativeOperationSignal(connection);
        const reply = await miyousheBalance?.(user, balanceProfile, signal);
        if (reply !== undefined && !signal.aborted && allowed(features)) {
          await event.reply(group ? [segment.at(user), "\n" + reply] : reply);
        }
      }
      return;
    }
    if (allowed(calendarScheduleNames) && await handleCalendarSchedule(event, allowNew)) return;
    if (allowNew && commands.hasModule("@lotus-yunzai/execute")) {
      const delegation = commandDelegation.authorize(event);
      if (delegation) {
        try {
          const reply = await commands.dispatchFallback(delegation.event,
            names => names[0] === "@lotus-yunzai/execute" && allowed(names),
            userId => event.self_id !== undefined && masterPermissions.isMaster(event.self_id, userId));
          if (reply !== undefined) {
            await sendCommandReply(event, reply);
            return;
          }
        } finally {
          delegation.close();
        }
      }
    }
    if (/^#(?:原神)?(?:删除全部面板|删除面板(?:数据)?)\s*(?:[1-9]\d{8,9}(?:\s+档案\s*[1-9]\d{0,2})?|(?:档案\s*)?[1-9]\d{0,2})?$/u.test(event.msg)) {
      if (allowNew) {
        const reply = await commands.dispatchFallback(event, names => names[0] === "@lotus-yunzai/genshin" && allowed(names),
          user => event.self_id !== undefined && masterPermissions.isMaster(event.self_id, user));
        if (reply !== undefined) await sendCommandReply(event, reply);
      }
      return;
    }
    if (event.msg === unregisterCheckinCommand || event.msg === checkinStatusCommand) {
      const status = event.msg === checkinStatusCommand;
      const features = status ? [$t("app.text_389d388d28"), "@lotus-yunzai/checkin-status"] : [$t("app.text_ccf4f493b4"), "@lotus-yunzai/checkin-registration"];
      if (!allowNew) return;
      const scope = ownCheckinSession(event, features);
      if (!scope) return;
      const reply = await (status ? readCheckinStatus : unregisterCheckin)(String(scope.user), scope);
      if (reply !== undefined && scope.isCurrent()) await event.reply(reply);
      return;
    }
    if (!event.isDelegated && await legacy.dispatchContext(event, allowed)) {
      handled?.();
      return;
    }
    const useKeywords = allowed(keywordFeatureNames);
    if (!event.isDelegated && useKeywords && await keywords.continue(event)) {
      handled?.();
      return;
    }
    if (allowNew && allowed(ownerAccountFeatureNames) && await ownerAccount(event, nativeOperationSignal(),
      () => groupDispatch.allowsInbound(event) && allowed(ownerAccountFeatureNames))) {
      handled?.();
      return;
    }
    if (allowNew && allowed(ownerQzoneFeatures) && await ownerQzone(event, nativeOperationSignal(),
      () => groupDispatch.allowsInbound(event) && allowed(ownerQzoneFeatures))) {
      handled?.();
      return;
    }
    if (await groupAvatar(event, {
      allowNew, workflow: nativeOperationSignal,
      allowed: kind => groupDispatch.allowsInbound(event) && allowed(kind === "group" ? groupAvatarNames : ownerAccountFeatureNames),
      permitted: async () => !await privateAccess.blocked(event),
    })) {
      handled?.();
      return;
    }
    const imageOcrNames = [$t("app.text_e3d4f76633"), "group", "@lotus-yunzai/group"];
    if (allowed(imageOcrNames) && await imageOcr(event, {
      allowNew, signal: nativeOperationSignal(),
      permitted: async () => groupDispatch.allowsInbound(event) && allowed(imageOcrNames) && !await privateAccess.blocked(event),
    })) {
      handled?.();
      return;
    }
    if (!event.isDelegated && event.message_type === "group" && /^#?(?:确认|取消)清理$/u.test(event.msg)) {
      const reply = await commands.dispatchFallback(event,
        names => names[0] === "@lotus-yunzai/group" && names.includes("[group] 从未发言成员") && allowed(names),
        user => event.self_id !== undefined && masterPermissions.isMaster(event.self_id, user));
      if (reply !== undefined) {
        await sendCommandReply(event, reply);
        return;
      }
    }
    const quotedInvitation = event.message_type === "private" && event.reviewQuotedGroupInvitation !== undefined;
    const quotedFriend = event.message_type === "private" && event.sendQuotedOwnerFriendReply !== undefined && /^#?回复(?:\s|$)/u.test(event.msg);
    if (!event.isDelegated && quotedFriend && event.reply_id !== undefined) {
      const reply = await commands.dispatchFallback(event,
        names => names[0] === "@lotus-yunzai/group" && names.includes("[group] 主人回复好友") && allowed(names),
        user => event.self_id !== undefined && masterPermissions.isMaster(event.self_id, user));
      if (reply !== undefined) {
        await sendCommandReply(event, reply);
        return;
      }
    }
    if (!event.isDelegated && (event.message_type === "group" || quotedInvitation) && event.reply_id !== undefined && isGroupJoinReviewInput(event.msg)) {
      const feature = quotedInvitation ? $t("app.text_b107c631f6") : $t("app.text_750680acf9");
      const reply = await commands.dispatchFallback(event,
        names => names[0] === "@lotus-yunzai/group" && names.includes(feature) && allowed(names),
        user => event.self_id !== undefined && masterPermissions.isMaster(event.self_id, user));
      if (reply !== undefined) {
        await sendCommandReply(event, reply);
        return;
      }
    }
    if (!allowNew) {
      if (legacyCharacterAliases.acceptsContinuation(event)) {
        const reply = await commands.dispatchFallback(event, names => names[0] === legacyCharacterAliases.name && allowed(names),
          user => event.self_id !== undefined && masterPermissions.isMaster(event.self_id, user));
        if (reply !== undefined) await sendCommandReply(event, reply);
      }
      return;
    }
    const groupRules = allowed(groupBannedWordsNames), screenedWords = allowed(groupScreenedWordsNames);
    if ((groupRules || screenedWords) && await handleGroupBannedWords(incoming, event.msg, alias, groupRules, screenedWords)) return;

    const commandMessage = normalizeDeviceInfoCommand(originalPictureCommand);
    const command = normalizeGameCommand(commandMessage === event.msg ? event : { ...event, msg: commandMessage });
    const namedCheckin = namedCheckinCommand(command.msg);
    if (namedCheckin) {
      const features = ["@lotus-yunzai/checkin"];
      const scope = ownCheckinSession(event, features);
      if (!scope || !runNamedCheckin) return;
      const { user, signal, privateFriend, isCurrent, verifySession } = scope;
      const reply = await runNamedCheckin(String(user), namedCheckin, {
        signal,
        verifySession,
        notify: privateFriend ? message => isCurrent() ? event.reply(message) : false : undefined,
      });
      if (reply !== undefined && isCurrent()) await sendCommandReply(event, reply);
      return;
    }
    const sendMedia = command.isDelegated ? undefined : command[sendSessionMedia];
    const deliverMedia = sendMedia && ((file: MediaDelivery) => mediaDelivery.deliver(file, sendMedia));
    if (deliverMedia) Object.defineProperty(command, "deliverMedia", { value: deliverMedia });
    if (updateCheck) {
      if (allowed(updateFeatureNames)) await checkForUpdate(command);
      return;
    }
    if (updateNoticeChange) {
      if (allowed(updateFeatureNames)) await configureUpdateNotice(command, updateNoticeChange);
      return;
    }
    if (isUpdateLogCommand(command.msg)) {
      if (allowed(updateFeatureNames)) await updateLogCommand(command);
      return;
    }
    if (!namedShowcase && isUpdateCommand(command.msg)) {
      if (allowed(updateFeatureNames)) await updateCommand(command);
      return;
    }
    if (isLogCommand(command.msg)) {
      if (allowed([$t("app.text_482462849e"), "system", "@lotus-yunzai/system"])) await logCommand(command);
      return;
    }
    const ownGroupCardAccount = !command.isDelegated && command.msg === "#更新群名片" ? command[ownGroupCardSession]?.() : undefined;
    const authorizeOfficialNoticePush = /^#(?:推送米游社全部|推送资讯|[^\s#]+推送(?:公告|资讯))(?:\s|$)/u.test(command.msg)
      ? () => !stopping && handoff.accepting && !dispatchPower.paused && !event.isDelegated && canManagePackages(event) &&
        (event.message_type === "terminal" ? masterPermissions.terminal :
          event.self_id !== undefined && event.user_id !== undefined &&
          event[delegationSession]?.signal.aborted === false && masterPermissions.isMaster(event.self_id, event.user_id) &&
          (event.adapter !== "milky" || onlineMilkyBotId() === event.self_id))
      : undefined;
    const authorizeCheckinOwner = () => {
      if (stopping || !handoff.accepting || event.isDelegated || event.attachmentOnly) return false;
      if (event.message_type === "terminal") return event.isMaster && masterPermissions.terminal;
      const { self_id, user_id } = event;
      if (self_id === undefined || user_id === undefined || event[delegationSession]?.signal.aborted !== false) return false;
      const currentBot = event.adapter === "milky" ? isMilkyOwnerSession(event) && onlineMilkyBotId() === self_id
        : event.boundAccount === true;
      return currentBot && masterPermissions.isMaster(self_id, user_id);
    };
    const context: CommandContext = {
      ...command, runtimeDiagnosticsScope: milkyDiagnostics ? "milky" : undefined, runtimeStatusScope, ownGroupCardAccount,
      atlasMaintenance, deliverMedia, authorizeOfficialNoticePush, authorizeCheckinOwner,
    };
    const reply = await commands.dispatch(command.msg, context, allowed);
    if (reply !== undefined) {
      await sendCommandReply(event, reply);
      return;
    }
    const { self_id } = event;
    const isBotMaster = (userId: number) => self_id !== undefined && masterPermissions.isMaster(self_id, userId);
    if (isGachaExpectationInput(command.msg)) {
      if (!allowed(gachaExpectationNames)) return;
      const scope = event.delegationSignal ?? event[delegationSession]?.signal;
      const calculationSignal = scope ? nativeOperationSignal(scope) : nativeOperationSignal();
      const request = { ...event, calculationSignal };
      const estimate = await commands.dispatchFallback(request,
        (names) => names[0] === gachaExpectationModuleName, isBotMaster, command.msg);
      if (estimate !== undefined && !calculationSignal.aborted) {
        handled?.();
        await sendCommandReply(event, estimate);
      }
      return;
    }
    if (statusPhoto && runtimeStatusScope) {
      const photoEvent = { ...event, runtimeStatusScope };
      const original = await commands.dispatchFallback(photoEvent,
        (names) => names[0] === systemModuleName && allowed(names), isBotMaster, command.msg);
      if (original !== undefined) {
        await sendCommandReply(event, original);
        return;
      }
    }
    const starRailPhoto = command.msg === "#星铁原图" && event.lookupReply !== undefined && !event.isDelegated;
    if ((statusPhoto && runtimeStatusScope) || starRailPhoto) {
      const session = event.message_type === "group" && event.listCurrentGroupMembers !== undefined
        ? event[delegationSession]?.signal : undefined;
      const groupOriginalSignal = session && nativeOperationSignal(session);
      if (groupOriginalSignal) {
        const modules = starRailPhoto ? ["@lotus-yunzai/starrail"]
          : ["@lotus-yunzai/zzz", "@lotus-yunzai/genshin", "@lotus-yunzai/starrail"];
        for (const moduleName of modules) {
          if (groupOriginalSignal.aborted) return;
          const artwork = await commands.dispatchFallback(event,
            (names) => names[0] === moduleName && allowed(names), isBotMaster, command.msg, { groupOriginalSignal });
          if (artwork !== undefined && !groupOriginalSignal.aborted) {
            await sendCommandReply(event, artwork);
            return;
          }
        }
      }
    }
    const redeemSetting = isPreviewRedeemSetting(command.msg);
    const redeemConnection = redeemSetting ? event[delegationSession]?.signal : undefined;
    const manualRedeem = isManualRedeemCommand(command.msg);
    const manualRedeemSignal = manualRedeem && event.privateCredentialSignal ? nativeOperationSignal(event.privateCredentialSignal) : undefined;
    if (manualRedeem && (!allowNew || event.attachmentOnly || manualRedeemSignal?.aborted)) return;
    const redeemEvent = redeemSetting ? {
      ...event, privateCredentialSignal: redeemConnection && nativeOperationSignal(redeemConnection),
    } : manualRedeem ? { ...event, privateCredentialSignal: manualRedeemSignal } : event;
    const redeemReply = await commands.dispatchFallback(redeemEvent,
      (names) => names[0] === "@lotus-yunzai/redeem-codes" && allowed(names), isBotMaster, command.msg);
    if (redeemReply !== undefined) {
      if (!manualRedeemSignal?.aborted) await sendCommandReply(event, redeemReply);
      return;
    }
    if (manualRedeem) return;
    if (/^#绝区零[^\p{Cc}\p{Cf}]{1,80}影画$/u.test(command.msg)) {
      // The V3 Atlas shortcut also matches this suffix. The explicit 图鉴 suffix still goes to Atlas.
      const cinema = await commands.dispatchFallback(event,
        (names) => names[0] === "@lotus-yunzai/zzz" && allowed(names), isBotMaster, command.msg);
      if (cinema !== undefined) {
        await sendCommandReply(event, cinema);
        return;
      }
    }
    // 旧角色卡的 accept 先改写原神裸名，再由 Atlas 检查公开图鉴。
    if (!command.isDelegated && command.game !== "sr" && command.game !== "zzz" &&
        command.msg.startsWith("#") && commands.hasModule("@lotus-yunzai/genshin")) {
      const avatar = await import("./plugins/genshin/panel/avatar-card.ts").catch(() => undefined);
      const avatarMessage = await avatar?.resolveLegacyGenshinAvatarMessage(command.msg);
      if (avatarMessage) {
        const card = await commands.dispatchFallback(event, allowed, isBotMaster, avatarMessage,
          undefined, "@lotus-yunzai/genshin");
        if (card !== undefined) {
          handled?.();
          await sendCommandReply(event, card);
          return;
        }
      }
    }
    let denied = false;
    if (await legacy.dispatch(command, allowed, () => { denied = true; })) {
      if (!denied) handled?.();
      return;
    }

    if (isInstallCommand(command.msg)) {
      if (allowed(installFeatureNames)) await installCommand(command);
      return;
    }

    if (isRecallCommand(command) && !command.isDelegated && allowed(recallFeatureNames)) {
      const recallSignal = nativeOperationSignal();
      const active = () => !recallSignal.aborted && !stopping && handoff.accepting && !dispatchPower.paused;
      const recalled = runQuotedRecall(incoming, active);
      const results = recalled ? await recalled : isProcessMaster(command) && active() ? await command.recallReply?.() : undefined;
      if (results === undefined) return;
      if (typeof results === "string") {
        await command.reply(results, true);
        return;
      }
      const confirmed = results.filter((result) => result === "confirmed").length;
      if (!results.length) await command.reply($t("app.text_d703a87309"));
      else if (results.includes("unknown")) await command.reply($t("app.text_f94894b92f", { "confirmed": confirmed }));
      else if (confirmed < results.length) await command.reply($t("app.text_b7394a8074", { "confirmed": confirmed }));
      return;
    }
    if (/^#(?:通知设置|(?:启用|禁用)全部通知$)/u.test(command.msg)) {
      if (!allowed(noticeSettingsNames)) return;
      const session = event[delegationSession]?.signal;
      const userId = event.user_id;
      const signal = session && nativeOperationSignal(session);
      const reply = await commands.dispatchFallback(event, (names) => names[0] === "@lotus-yunzai/group" && allowed(names),
        isBotMaster, command.msg, {
          async configureNoticeSettings(scope) {
            const group = event.message_type === "group" && event.sub_type !== "anonymous" && event.group_id !== undefined;
            const friend = event.message_type === "private" && event.sub_type === "friend";
            if (!signal || signal.aborted || event.isDelegated || event.attachmentOnly || userId === undefined || !isBotMaster(userId) ||
                !(group || friend) || ((scope === "group" || scope === "bot-group") && !group) || !allowed(noticeSettingsNames)) return false;
            if (scope === "bot" || scope === "bot-group") return true;
            const accounts = new Set(masterPermissions.botIds());
            for (const account of groups.onlineAccounts()) accounts.add(account.id);
            if (milkyOnline && !milkyOnline.signal.aborted) accounts.add(milkyOnline.id);
            return accounts.size > 0 && [...accounts].every(account => masterPermissions.isMaster(account, userId));
          },
        });
      if (reply !== undefined) {
        await sendCommandReply(event, reply);
        return;
      }
    }
    if (/^(?:[%％]|[#/](?:绝区零|zzz)|绝区零|zzz)(?:绝区零|zzz)?(?:上传|添加|获取|查看|删除)\S{1,80}(?:角色|面板)图(?:[0-9,，、\s]+)?$/iu.test(command.msg)) {
      const connection = event[delegationSession]?.signal;
      const active = connection && nativeOperationSignal(connection);
      const allowedSource = () => active && !active.aborted && !event.isDelegated && !event.attachmentOnly &&
        event.user_id !== undefined && isBotMaster(event.user_id) &&
        (event.message_type === "group" && event.sub_type !== "anonymous" || event.message_type === "private" && event.sub_type === "friend");
      const reply = await commands.dispatchFallback(event, names => names[0] === "@lotus-yunzai/zzz" && allowed(names),
        isBotMaster, command.msg, {
          characterGallerySignal: active,
          async readCharacterGalleryImages() {
            if (!active || !allowedSource() || typeof event.message === "string") return [];
            let images = event.message.filter(part => part.type === "image");
            if (!images.length && event.lookupReply && event.reply_id !== undefined &&
                event.message.filter(part => part.type === "reply").length === 1) {
              const quoted = await event.lookupReply().catch(() => undefined);
              images = quoted?.message.filter(part => part.type === "image") ?? [];
            }
            if (images.length > 5) return "too-many";
            const bytes: (Uint8Array | undefined)[] = [];
            for (const part of images) {
              if (!allowedSource()) return [];
              bytes.push(await readQqMessageSegmentMedia(part, active));
            }
            return allowedSource() ? bytes : [];
          },
        });
      if (reply !== undefined) {
        await sendCommandReply(event, reply);
        return;
      }
    }
    const teamDamageSession = /^#星铁\s*(?:队伍伤害|队伤|伤害)/u.test(command.msg)
      ? event[delegationSession]?.signal : undefined;
    const fallbackEvent = bareStatus && runtimeStatusScope ? {
      ...event, runtimeStatusScope, runtimeDiagnosticsScope: milkyDiagnostics ? "milky" as const : undefined,
    } : teamDamageSession ? { ...event, calculationSignal: nativeOperationSignal(teamDamageSession) } : event;
    const deliveryEvent = deliverMedia ? { ...fallbackEvent, deliverMedia } : fallbackEvent;
    const packageManagement = !event.isDelegated && canManagePackages(event) ? { canManagePackages: true as const } : undefined;
    const panelUpdate = /^#?(?:(原神|星铁|米游社|mys)\s*)*(?:全部面板更新|更新全部面板|获取游戏角色详情|更新面板|面板更新)(?:[1-9\s]|$)/iu.test(command.msg);
    let offerLegacyPanelRecovery;
    if (panelUpdate && event.message_type === "private" && event.self_id !== undefined &&
        await legacyPanelRecoveryEnabled().catch(() => false)) {
      const game = /^#星铁/u.test(command.msg) ? "sr" : "gs";
      const scope = ownCheckinSession(event, panelSignatureFeatures[game]);
      if (scope?.privateFriend) {
        const session = { ...scope, bot: event.self_id, adapter: event.adapter === "milky" ? "milky" as const : "onebot" as const };
        const offer = legacyPanelRecovery.offer(session);
        offerLegacyPanelRecovery = (candidate: Parameters<typeof offer>[0]) => candidate.game === game ? offer(candidate) : Promise.resolve(undefined);
      }
    }
    const fallback = await commands.dispatchFallback(deliveryEvent,
      (names) => names[0] !== "@lotus-yunzai/redeem-codes" && allowed(names), isBotMaster, command.msg,
      { ...packageManagement, offerLegacyPanelRecovery, authorizeCheckinOwner });
    if (fallback !== undefined) {
      await sendCommandReply(event, fallback);
      return;
    }
    if (useKeywords && await keywords.dispatch(event)) handled?.();
  }

  async function handleCalendarSchedule(event: MessageEvent, allowCommand: boolean): Promise<boolean> {
    const registration = calendarSchedule;
    if (!registration) return false;
    const explicit = registration.policy.matchesCommand(event.msg);
    if (event.isDelegated || (explicit && !allowCommand)) return explicit;
    const transport = event[delegationSession]?.signal;
    const { self_id, user_id, group_id, message_type } = event;
    const terminal = message_type === "terminal" && masterPermissions.terminal;
    const owner = transport && self_id !== undefined && user_id !== undefined && masterPermissions.isMaster(self_id, user_id);
    if (!terminal && !owner) {
      if (explicit) {
        const reply = await registration.policy.handle(event.msg);
        if (reply !== undefined) await event.reply(reply);
      }
      return explicit;
    }
    const active = nativeOperationSignal(registration.signal, transport ?? lifecycle.signal);
    if (active.aborted) return explicit;
    const key = terminal ? "terminal" : JSON.stringify([event.adapter ?? "onebot", self_id, user_id, message_type, group_id]);
    const reply = await registration.policy.handle(event.msg, { key, signal: active });
    if (reply !== undefined && !active.aborted) await event.reply(reply);
    return explicit || reply !== undefined;
  }

  const interrupt = () => {
    if (stopping) return;
    const report = !handoff.managed;
    stop(0);
    if (report) console.info(formatTerminalLog("mark", $t("app.text_e5a73c676a")));
  };
  const terminate = () => stop(143);
  if (handoff.managed) {
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
  } else {
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
  }
  try {
    if (previous) await verifyMovedRuntimePaths(fileURLToPath(root), previous, Bun.env);
    const botConfig = withDefaultUpdateSchedule(await readLocalConfig(root, "bot"));
    panelTransfer = configurePanelTransfer(botConfig.panelTransfer, lifecycle.signal);
    setImageRenderPreset(botConfig.imageRenderPreset);
    setImageFooter(botConfig.imageFooter);
    runtimeLogConfig = botConfig;
    installTerminalLogging(botConfig);
    const watchConfig = botConfig.file_watch !== false && !probingUpdate ? lifecycle.signal : undefined;
    const [network, permissions, globalConfig, access, requestPolicies, routing,
      runtimeVersion, milky] = await Promise.all([
      readServerSettings(root, Bun.env), readMasterPermissions(root, watchConfig), readLotusGlobalConfig(root),
      readPrivateAccess(root, async (userId) =>
        !globalThis.redis || await globalThis.redis.set(`Yz:disablePrivate:${userId}`, "1", { EX: 10, NX: true }) === "OK",
      watchConfig !== undefined),
      readRequestOtherPolicies(root, watchConfig),
      readGroupDispatch(root, watchConfig),
      readRuntimeVersion(root),
      probingUpdate ? undefined : readMilkySettings(root).catch(() => {
        console.warn($t("app.text_0744e5ae6f"));
        return undefined;
      }),
    ]);
    if (previous) {
      const directory = fileURLToPath(root);
      await verifyMovedHttpsPaths(directory, previous, network.https);
      await verifyMovedWebMount(directory, previous, network.webMount);
    }
    const checkinScope = (scope: "checkin.refresh" | "scheduler.generate" | "scheduler.run_due") => {
      const allows = accountScopePermission(globalConfig, scope);
      return (context: CommandContext) => allows({ ...context, isMaster: isCheckinCommandOwner(context) });
    };
    const canRefresh = checkinScope("checkin.refresh");
    const canRegisterCheckin = accountScopePermission(globalConfig, "checkin.register");
    const canRegisterGroup = accountScopePermission(globalConfig, "checkin.group_register");
    const canGenerate = checkinScope("scheduler.generate");
    const canRunDue = checkinScope("scheduler.run_due");
    masterPermissions = permissions;
    privateAccess = access;
    try {
      runtimeLog = await attachRuntimeLog(root, botConfig);
      console.info(formatTerminalLog("mark", "----^_^----"));
      console.info(formatTerminalLog("mark", $t("app.text_2cf0e8938c", { "value1": runtimeVersion.version || runtimeVersion.revision ? " " + (runtimeVersion.version ?? runtimeVersion.revision?.slice(0, 7)) : "" })));
    } catch {
      console.warn($t("app.text_16acfb44fb"));
    }
    if (watchConfig) watchConfigFiles(watchConfig, async () => {
      const revision = runtimeLogRevision;
      const { log_level } = await readLocalConfig(root, "bot");
      const level = typeof log_level === "string" ? log_level.toLowerCase() : log_level;
      if (level !== undefined && !isLogLevel(level)) throw new Error($t("app.text_b5cc563776"));
      if (!watchConfig.aborted && revision === runtimeLogRevision) runtimeLogConfig.log_level = level;
    }, () => console.warn($t("app.text_ae1f3eeec4")));
    autoFriend = await readFriendRequests(root, undefined, requestPolicies);
    otherPolicies = requestPolicies;
    groupDispatch = routing;
    keywords = createKeywords(createKeywordStore(root), routing.keywordSettings, undefined, {
      async read(actor) {
        if (!globalThis.redis) return;
        const id = Number(await storage("keywords").get(`recent:${actor}`));
        if (Number.isSafeInteger(id) && id > 0) return id;
      },
      async write(actor, id) {
        if (globalThis.redis) await storage("keywords").set(`recent:${actor}`, String(id), 2_592_000);
      },
      legacy: {
        async read(user) {
          const id = await globalThis.redis?.eval(`
            if redis.call('PTTL', KEYS[1]) <= 0 then return false end
            return redis.call('GET', KEYS[1])
          `, { keys: [`Yz:group_id:${user}`], arguments: [] });
          if (typeof id !== "string" || !/^[1-9]\d*$/u.test(id)) return;
          const group = Number(id);
          if (Number.isSafeInteger(group)) return group;
        },
        allows(event, group_id) {
          const scope = { self_id: event.self_id, user_id: event.user_id, group_id };
          return routing.allowsInbound(scope) && routing.allows(scope, keywordFeatureNames);
        },
      },
    });
    reviewInvitation = await readGroupInvitations(root, requestPolicies);
    autoQuit = await readAutoQuit(root, permissions.masterIds, permissions.legacyMasterIds, requestPolicies);
    masterEnrollment = createMasterEnrollment({
      isMaster: permissions.isMaster, masterIds: permissions.masterIds,
      isTerminalMaster: () => permissions.terminal, grant: permissions.grant,
    });
    const restoredStorage = await handoff.restoreStorage(lifecycle.signal);
    const valkey = restoredStorage !== undefined ? restoredStorage ?? undefined
      : probingUpdate ? undefined : (await ensureManagedValkey(root, { signal: lifecycle.signal })).connection;
    handoff.verifyStorage(valkey ?? null);
    const segmentCounts = botConfig.msg_type_count === true || botConfig.msg_type_count === 1 || botConfig.msg_type_count === "1";
    onlineCooldown = onlineNoticeSeconds(botConfig.online_msg_exp);
    onlineVersion = runtimeVersion.version;
    counts = createMessageCounts(() => globalThis.redis, segmentCounts);
    if (valkey !== undefined) {
      globalThis.redis = await connectStorage(valkey);
      console.log($t("app.text_46b2c5c839"));
    }
    const legacyPause = globalThis.redis && recordedPause === undefined && !dispatchPower.paused
      ? await readLegacyDispatchPause(globalThis.redis).catch(() => {
        console.warn($t("app.text_ec36e0f6d7"));
      })
      : undefined;
    if (legacyPause) dispatchPower.restorePaused(legacyPause.pausedAt);
    const accounts = accountCommands(Bun.env.LOTUS_PROFILE_DIR || undefined, canRefresh, undefined, async (...args) => {
      const { renderStatusCard } = await import("@lotus-yunzai/skia/status-card");
      if (args[0] === "登录列表") {
        const themeDirectory = Bun.env.LOTUS_ATLAS_THEME_DIR?.trim() || fileURLToPath(new URL("./data/atlas/theme/", root));
        if (!await Bun.file(`${themeDirectory}/bg/bg-hydro.webp`).exists()) throw new Error($t("app.text_3f9d31c539"));
        return renderStatusCard(...args, { themeDirectory });
      }
      return renderStatusCard(...args);
    });
    commands.registerModule(accounts);
    commands.registerModule(donationCommands(lifecycle.signal));
    const viewProfile = (id: number, { message_type, self_id, user_id, group_id, isMaster, inlineImageByteLimit,
      groupActivitySignal, privateCredentialSignal }: CommandContext) =>
      accounts.commands[`#配置${id === 1 ? "" : id}`]!("", {
        message_type, self_id, user_id, group_id, isMaster, inlineImageByteLimit, groupActivitySignal, privateCredentialSignal,
      });
    const hoyoTransport = hoyoTransportForBot(botConfig.proxyAddress);
    commands.registerModule(deviceCommands(Bun.env.LOTUS_PROFILE_DIR || undefined, lifecycle.signal,
      viewProfile, undefined, { transport: hoyoTransport }));
    commands.registerModule(dailyNoteCommands(Bun.env.LOTUS_PROFILE_DIR || undefined, lifecycle.signal, hoyoTransport));
    commands.registerModule(legacyAnniversaryCommands(root, Bun.env.LOTUS_PROFILE_DIR || undefined, lifecycle.signal));
    commands.registerModule(gachaExpectationCommands(calculateGachaPulls, sampleGachaCharacterReturns));
    const checkinAudit = createCheckinAudit(fileURLToPath(new URL("data/audit/checkin.jsonl", root)), undefined,
      legacyLotusDirectories.map(id => fileURLToPath(new URL(`plugins/${id}/data/audit/checkin.jsonl`, root))));
    const profileDirectory = Bun.env.LOTUS_PROFILE_DIR || undefined;
    const checkinProfiles = createProfileStore(profileDirectory);
    if (!probingUpdate) commands.registerModule(groupCleanupCommands({
      profiles: checkinProfiles, auditPath: fileURLToPath(new URL("data/audit/group-cleanup.jsonl", root)),
      readConfig: () => readLotusGlobalConfig(root), isMaster: permissions.isMaster, activeSignal: nativeOperationSignal,
    }), "@lotus-yunzai/group");
    if (!probingUpdate) commands.registerModule(groupMemberExportCommands({
      readConfig: () => readLotusGlobalConfig(root), isMaster: permissions.isMaster, activeSignal: nativeOperationSignal,
    }), "@lotus-yunzai/group");
    if (!probingUpdate) commands.registerModule(permissionCommands({
      root, terminalOwner: () => permissions.terminal, activeSignal: nativeOperationSignal,
    }));
    const checkinScheduleStore = createCheckinScheduleStore(fileURLToPath(new URL("data/schedules/", root)),
      legacyLotusDirectories.map(id => ({ id, directory: fileURLToPath(new URL(`plugins/${id}/data/schedules/`, root)) })));
    const generatedDevices = createGeneratedDeviceRefresh(checkinProfiles, { transport: hoyoTransport,
      signal: AbortSignal.any([lifecycle.signal, handoffSession.signal]) });
    if (!probingUpdate) {
      const prepared = await generatedDevices.prepare();
      if (prepared.generated) console.info($t("app.text_42f948913b", { "generated": prepared.generated }));
      if (prepared.failed) console.warn($t("app.text_20e1cfd731", { "failed": prepared.failed }));
      whenModuleTasksActive(() => generatedDevices.start());
    }
    if (!probingUpdate) {
      try {
        captchaService = createCaptchaService({
          config: globalConfig.captcha, signal: lifecycle.signal, manualRelay: () => manualCaptcha,
          async notify({ qq, profileId }, event, signal) {
            const userId = Number(qq);
            if (!Number.isSafeInteger(userId) || userId < 1 || signal.aborted || stopping || !handoff.accepting) return false;
            const message = event.type === "manual"
              ? $t("app.text_f5b87c817a", { "profileId": profileId, "link": event.link })
              : event.type === "automatic" ? $t("app.text_92fc95a61f", { "profileId": profileId })
              : event.type === "accepted" ? $t("app.text_3a8adb64ce", { "profileId": profileId })
              : $t("app.text_19ed2fc608", { "profileId": profileId });
            const candidates = [...groups.checkinNotifications(), ...(milkyOnline ? [milkyOnline.checkinNotify] : [])]
              .filter((transport): transport is NonNullable<typeof transport> => transport !== undefined);
            for (const transport of candidates) {
              if (signal.aborted || stopping) return false;
              if (!await transport.friendship?.(userId)) continue;
              if (signal.aborted || stopping) return false;
              return await transport.sendPrivate(userId, message) === "confirmed";
            }
            return false;
          },
          report({ provider, round, attempt, reason }) {
            console.info($t("app.text_9027c66a53", { "provider": provider, "round": round, "attempt": attempt, "reason": reason }));
          },
        });
        setDefaultCaptchaSolver(captchaService);
      } catch {
        console.warn($t("app.text_31bad54ac6"));
      }
    }

    cloudGenshinWallet = createCloudGenshinWalletQuery({
      readDomesticCloud: checkinProfiles.domesticCloudGenshin, readProfile: checkinProfiles.checkinSettings, transport: hoyoTransport,
    });
    miyousheBalance = createMiyousheBalanceQuery(profileDirectory, hoyoTransport);
    if (!probingUpdate) {
      const settings = globalConfig.daily_note_reminders as { readonly enable?: boolean; readonly cooldown_hours?: unknown; readonly cron?: unknown; readonly message?: unknown } | undefined;
      const reminderThemeDirectory = Bun.env.LOTUS_DAILY_NOTE_REMINDER_THEME_DIR?.trim() ||
        builtinResourceDirectory("core/daily-note-reminder", root);
      dailyNoteReminders = createDailyNoteReminders({
        directory: profileDirectory, file: fileURLToPath(new URL("data/daily-note/reminders.sqlite", root)),
        signal: lifecycle.signal, enabled: settings?.enable === true, activeSignal: nativeOperationSignal,
        transports: subscriptionTransport, transport: hoyoTransport,
        cooldownHours: settings?.cooldown_hours, cron: settings?.cron, message: settings?.message,
        async reminderImage(model, { signal, inlineImageByteLimit }) {
          signal.throwIfAborted();
          const card = await renderDailyNoteReminderCard(model, { resourceDirectory: reminderThemeDirectory, inlineImageByteLimit });
          signal.throwIfAborted();
          return card?.png;
        },
        async legacyTimeToLive(key) {
          const redis = globalThis.redis;
          if (redis?.isReady) return redis.pTTL(key);
        },
        allowed: ({ bot, group_id, qq }) => handoff.accepting && !stopping && !dispatchPower.paused &&
          groupDispatch.allowsInbound({ post_type: "message", message_type: "group", self_id: bot, group_id, user_id: qq }) &&
          groupDispatch.allowsScheduledGroup(bot, group_id, dailyNoteReminderFeatureNames),
      });
      commands.registerModule(dailyNoteReminders.commands);
    }
    const zzzRankClient = createProfileHoyoClient(checkinProfiles, hoyoTransport);
    const gameCheckin = gameCheckinCommands(profileDirectory, lifecycle.signal,
      { manualRelay: () => manualCaptcha, audit: checkinAudit, transport: hoyoTransport, scheduleStore: checkinScheduleStore,
        prepareDevice: (qq, profileId) => generatedDevices.refresh(qq, profileId) });
    runNamedCheckin = gameCheckin.runNamed;
    const previewSignal = AbortSignal.any([lifecycle.signal, handoffSession.signal]);
    const previewOptions = {
      historyFile: fileURLToPath(new URL("data/redeemCodes/activities.json", root)), signal: previewSignal,
      legacyHistoryFiles: legacyLotusDirectories.map(id => fileURLToPath(new URL(`plugins/${id}/data/redeemCodes/activities.json`, root))),
    };
    const publicPreview = new RedeemCodeService(previewOptions);
    let previewSettings: Parameters<typeof createMiyousheWeb>[0]["previewSettings"];
    if (probingUpdate) {
      commands.registerModule(redeemCodeCommands(previewOptions, publicPreview));
    } else {
      const previewClient = createProfileHoyoClient(checkinProfiles);
      const preview = createPreviewRedeemRunner({
        journal: fileURLToPath(new URL("data/redeemCodes/auto.json", root)),
        legacyJournal: legacyLotusDirectories.map(name =>
          fileURLToPath(new URL(`plugins/${name}/data/redeemCodes/auto.json`, root))),
        lookup: game => publicPreview.query(game),
        listProfiles: checkinProfiles.listPreviewRedeemProfiles,
        async readBinding({ qq, profileId }, game, signal) {
          const account = await checkinProfiles.previewRedeemAccount(qq, profileId, game);
          if (!account || signal?.aborted) return;
          const accountId = previewRedeemIdentity(account);
          if (accountId) return { accountId, selectedUid: account.selectedUid };
        },
        async readRoles({ qq, profileId }, game, signal) {
          const initial = await checkinProfiles.previewRedeemAccount(qq, profileId, game);
          if (!initial || !previewRedeemIdentity(initial)) return;
          const result = await previewClient.fetchBoundRoles(initial, game, signal);
          const account = await checkinProfiles.previewRedeemAccount(qq, profileId, game);
          if (!account || account.revision !== result.context.revision || account.selectedUid !== initial.selectedUid) return;
          const accountId = previewRedeemIdentity(account);
          if (!accountId) return;
          const checkBinding = async () => {
            const current = await checkinProfiles.previewRedeemAccount(qq, profileId, game);
            return current?.revision === account.revision;
          };
          return {
            accountId, roles: result.roles, selectedUid: account.selectedUid,
            submit: (code, role, active) => submitPreviewCode(account, game, role, code, fetch, active, async () => {
              if (!await checkBinding()) throw new Error($t("app.text_8d9a71e17f"));
            }),
            async notify(reply, active) {
              const settings = await checkinProfiles.previewRedeemSettings(qq, profileId);
              if (settings.revision !== account.revision) return;
              await notifyCheckin({
                userId: Number(qq), settings: settings.notify, reply, transports: subscriptionTransport(),
                signal: active ?? previewSignal, verifySend: checkBinding,
              });
            },
          };
        },
      });
      const manualRedeem = createManualRedeemCommand(checkinProfiles, fileURLToPath(new URL("data/redeemCodes/manual.json", root)),
        previewSignal, hoyoTransport);
      commands.registerModule(redeemCodeCommands(previewOptions, publicPreview, {
        profiles: checkinProfiles, signal: previewSignal, canRegister: canRegisterCheckin, hasHistory: preview.hasHistory,
      }, manualRedeem));
      registerModuleTask($t("app.text_8041e6891b"), "0 */5 * * * *",
        () => preview.scan(previewSignal, diagnostic => console.warn($t("app.text_c664cebfcc", { "diagnostic": diagnostic }))));
      previewSettings = {
        async read({ qq, profileId }, signal, verifyLogin) {
          await verifyLogin();
          const { enabled, games, revision, loggedIn, allowNewJournal } = await checkinProfiles.previewRedeemSettings(qq, profileId);
          const canEnable = loggedIn && (enabled || canRegisterCheckin({ user_id: Number(qq), isMaster: false }));
          const waitingForHistory = enabled && !allowNewJournal && !await preview.hasHistory().catch(() => false);
          signal.throwIfAborted();
          return { enabled, games, revision, canEnable, waitingForHistory };
        },
        async save(target, patch, signal, verifyLogin) {
          const current = await this.read(target, signal, verifyLogin);
          if (current.revision !== patch.revision) throw new MiyoushePreviewSettingsError(409, $t("app.text_0173552aba"));
          if (patch.enabled && !current.canEnable) throw new MiyoushePreviewSettingsError(403, $t("app.text_933a5a70a9"));
          let saved;
          try {
            saved = await checkinProfiles.setPreviewRedeemSettings(
              target.qq, target.profileId, patch.revision, patch.enabled, patch.games, signal, verifyLogin,
            );
          } catch (error) {
            if (error instanceof ProfileError && error.code === "changed") {
              await verifyLogin();
              throw new MiyoushePreviewSettingsError(409, $t("app.text_0173552aba"));
            }
            throw error;
          }
          const updated = await this.read(target, signal, verifyLogin);
          if (updated.revision !== saved.revision) throw new MiyoushePreviewSettingsError(409, $t("app.text_0173552aba"));
          return updated;
        },
      };
    }
    const milkyWebhookPath = milky?.connection === "webhook" ? milky.webhookPath : undefined;
    const shopSettings = miyousheWebSettings(globalConfig.coin_shop, milkyWebhookPath);
    const readWebLoginConfig = async () => (await readLotusGlobalConfig(root)).coin_shop;
    if (!probingUpdate && shopSettings.enabled) {
      if (shopSettings.mountConflict) console.warn($t("app.text_e1194f9fe5", { "path": shopSettings.path }));
      const plans = checkinScheduleStore;
      const scheduler = globalConfig.scheduler as CheckinScheduleConfig | undefined;
      const catalog = createMiyousheShopCatalog({ profileDirectory });
      const shopClient = createProfileHoyoClient(checkinProfiles);
      shopPlans = createMiyousheShopPlans({
        file: fileURLToPath(new URL("data/coinShop/plans.json", root)), profileDirectory,
        legacyFiles: legacyLotusDirectories.map(id => ({ id,
          file: fileURLToPath(new URL(`plugins/${id}/data/coinShop/plans.json`, root)),
        })),
        async receiptRoute(qq, { adapter, botId }, signal) {
          const userId = Number(qq);
          const active = () => !signal?.aborted && !lifecycle.signal.aborted && handoff.accepting && !stopping;
          if (!active() || !Number.isSafeInteger(userId) || userId < 1 || userId === botId) return;
          const milky = milkyOnline;
          const transport = adapter === "milky"
            ? milky?.id === botId && !milky.signal.aborted ? milky.checkinNotify : undefined
            : groups.checkinNotifications().find(session => session.botId === botId);
          if (!transport || !await transport.friendship?.(userId) || !active()) return;
          return async message => {
            if (!active() || (adapter === "milky" && (milky !== milkyOnline || milky?.signal.aborted))) return;
            return transport.sendPrivate(userId, message);
          };
        },
        tracking: {
          accountQuota(target, good, signal, verifyBinding) {
            const timeout = AbortSignal.timeout(3_000);
            return catalog.accountQuota(target, good, signal ? AbortSignal.any([signal, timeout]) : timeout, verifyBinding);
          },
          async catalog(target, game, signal, verifyBinding) {
            const goods = new Map<string, Awaited<ReturnType<typeof catalog.list>>["goods"][number]>();
            for (let page = 1; page <= 100; page++) {
              signal?.throwIfAborted();
              const catalogPage = await catalog.list(target, new URLSearchParams({ game, page: String(page) }), signal, verifyBinding);
              if (!catalogPage.goods.length) break;
              const previous = goods.size;
              for (const good of catalogPage.goods) {
                if (!goods.has(good.id)) goods.set(good.id, good);
              }
              if (goods.size === previous) throw new MiyousheShopPlanError(503, $t("app.text_03251595a3"));
              if (page >= catalogPage.totalPages) break;
            }
            return [...goods.values()];
          },
          async destinations(target, game, itemType, signal, verifyBinding) {
            if (itemType === 2) return { roles: trackingGame(game) ? await catalog.trackingRoles(target, trackingGames[game], signal, verifyBinding) : [] };
            await verifyBinding?.();
            const account = await checkinProfiles.accountContext(target.qq, target.profileId);
            return { addresses: await shopClient.fetchMiyousheShopAddresses(account, { signal, verifyBinding }) };
          },
        },
        async inspect(target, goodsId, signal, verifyBinding) {
          await verifyBinding?.();
          const { good, roles } = await catalog.detail(target, goodsId, signal, verifyBinding);
          const account = await checkinProfiles.accountContext(target.qq, target.profileId);
          await verifyBinding?.();
          if (good.price === null) throw new MiyousheShopPlanError(503, $t("app.text_9d56385bc0"));
          const { balance, addresses } = await shopClient.fetchMiyousheShopAccount(account, {
            signal, verifyBinding, includeAddresses: good.type === 1,
          });
          return { good: { ...good, price: good.price }, balance, roles, addresses };
        },
        manualRelay: () => manualCaptcha,
        async submit(plan, signal, verifyBinding, manual, firstDispatchAllowed) {
          await verifyBinding?.();
          const account = await checkinProfiles.accountContext(plan.qq, plan.profileId);
          return shopClient.exchangeMiyousheShopGoods(account, plan, { signal, verifyBinding, manual, firstDispatchAllowed });
        },
      });
      miyousheWeb = createMiyousheWeb({
        ...shopSettings, publicBase: () => shopSettings.origin ?? fileBase, readLoginConfig: readWebLoginConfig,
        signal: lifecycle.signal, loginIdentity: checkinProfiles.loginIdentity,
        databasePath: fileURLToPath(new URL("data/miyoushe/sessions.sqlite", root)),
        assetDirectory: fileURLToPath(new URL("web/miyoushe/", root)),
        overview: createMiyousheOverview({ profileDirectory, readTodaySchedule: plans.read, scheduleEnabled: scheduler?.enable !== false }),
        catalog, plans: shopPlans, previewSettings, shopVerificationSignal: handoffSession.signal,
        manualCheckin: {
          async revision({ qq, profileId }, signal, verifyLogin) {
            await verifyLogin();
            const { revision } = await checkinProfiles.checkinSettings(qq, profileId);
            signal.throwIfAborted();
            return revision;
          },
          run({ qq, profileId }, signal, verifyLogin) {
            const active = AbortSignal.any([signal, handoffSession.signal]);
            return gameCheckin.runWeb(qq, profileId, {
              signal: active, verifySession: verifyLogin,
              async notify(reply) {
                const result = await notifyCheckin({
                  userId: Number(qq), settings: { enabled: true, prefer: "private", fallbackGroups: [] },
                  reply, transports: subscriptionTransport(), signal: active,
                  async verifySend() {
                    await verifyLogin();
                    return !active.aborted;
                  },
                });
                return result.status === "confirmed" || result.status === "unknown";
              },
            });
          },
        },
        checkinSettings: {
          async read({ qq, profileId }, signal, verifyLogin) {
            await verifyLogin();
            const { loggedIn, ...current } = await checkinProfiles.webCheckinSettings(qq, profileId);
            signal.throwIfAborted();
            return { ...current, canEnable: loggedIn && (current.enabled || canRegisterCheckin({ user_id: Number(qq), isMaster: false })) };
          },
          async save(target, patch, signal, verifyLogin) {
            const { qq, profileId } = target;
            const current = await this.read(target, signal, verifyLogin);
            const conflict = () => new MiyousheSettingsError(409, $t("app.text_0173552aba"));
            if (current.revision !== patch.revision) throw conflict();
            if (patch.enabled && !current.canEnable) throw new MiyousheSettingsError(403, $t("app.text_94faea8ae1"));
            let saved;
            try {
              saved = await checkinProfiles.setWebCheckinSettings(qq, profileId, patch.revision, patch, signal, verifyLogin);
            } catch (error) {
              if (!(error instanceof ProfileError)) throw error;
              if (error.code === "invalid") throw new MiyousheSettingsError(400, error.message);
              if (error.code !== "changed") throw error;
              await verifyLogin();
              throw conflict();
            }
            const updated = await this.read(target, signal, verifyLogin);
            if (updated.revision !== saved.revision) throw conflict();
            if (saved.changed && current.enabled !== updated.enabled && checkinRuntime) {
              const runtime = checkinRuntime;
              try {
                if (updated.enabled) {
                  const profile = await checkinProfiles.checkinSettings(qq, profileId);
                  if (profile.revision === updated.revision) {
                    await runtime.addRegisteredProfile({ qq, profileId, name: profile.displayName, enabled: true, schedule: profile.schedule });
                  }
                } else await runtime.reconcileExistingPlans();
              } catch {
                console.warn($t("app.text_559c5a04da"));
              }
            }
            return updated;
          },
        },
        async shopAddresses(target, signal, verifyBinding) {
          const account = await checkinProfiles.accountContext(target.qq, target.profileId);
          return shopClient.fetchMiyousheShopAddresses(account, { signal, verifyBinding });
        },
      });
      commands.registerModule(miyousheWeb.commands);
    }
    commands.registerModule(hoyoLabProfileCommands(profileDirectory, lifecycle.signal, { viewProfile, transport: hoyoTransport }));
    commands.registerModule(cloudProfileCommands({
      signal: lifecycle.signal, viewProfile, readProfile: checkinProfiles.checkinSettings, setEnabled: checkinProfiles.setCloudGameEnabled,
      saveToken: checkinProfiles.saveCloudToken,
    }));
    commands.registerModule(gameCheckin);
    commands.registerModule(checkinAuditCommands(checkinAudit, lifecycle.signal));
    if (!probingUpdate) {
      commands.registerModule(checkinRosterCommands({
        profiles: checkinProfiles,
        listMembers: ({ listCheckinGroupMembers }) => listCheckinGroupMembers?.() ?? Promise.resolve(undefined),
        signal: lifecycle.signal,
      }));
      commands.registerModule(checkinBatchRefreshCommands({ profiles: checkinProfiles, signal: lifecycle.signal }));
      const config = globalConfig.scheduler;
      if (config === undefined || (config !== null && typeof config === "object" && !Array.isArray(config) &&
          (!Object.hasOwn(config, "enable") || typeof (config as CheckinScheduleConfig).enable === "boolean"))) {
        async function deliverCheckin(qq: string, profileId: number, reply: MessageReply, revision: string, verifyPlan?: () => Promise<boolean>) {
          const current = await checkinProfiles.checkinSettings(qq, profileId).catch(() => undefined);
          if (!current?.enabled || current.revision !== revision || lifecycle.signal.aborted ||
              (verifyPlan && !await verifyPlan())) return { status: "skipped" as const };
          const transports: CheckinNotifyTransport[] = [...groups.checkinNotifications()];
          if (milkyOnline?.checkinNotify && !milkyOnline.signal.aborted) transports.push(milkyOnline.checkinNotify);
          return notifyCheckin({
            userId: Number(qq), settings: current.notify, reply, transports, signal: lifecycle.signal,
            async verifySend() {
              const latest = await checkinProfiles.checkinSettings(qq, profileId).catch(() => undefined);
              return latest?.enabled === true && latest.revision === revision && (!verifyPlan || await verifyPlan());
            },
          });
        }
        const runtime = createCheckinScheduleRuntime({
          store: checkinScheduleStore,
          config: (config ?? {}) as CheckinScheduleConfig,
          listProfiles: checkinProfiles.listCheckinProfiles,
          signal: lifecycle.signal,
          noticeReady: signal => waitForCheckinNoticeTransport({ signal, available: () =>
            groups.checkinNotifications().length > 0 || Boolean(milkyOnline?.checkinNotify && !milkyOnline.signal.aborted) }),
          runProfile: (entry, scope) => gameCheckin.runScheduled(entry.qq, entry.profileId, scope),
          async onComplete(entry, result, attempt) {
            if (!result.reply || !result.revision || lifecycle.signal.aborted) return;
            const forumNames = (ids: readonly string[]) => ids.map(id => Object.hasOwn(bbsCheckinForums, id)
              ? bbsCheckinForums[id as BbsCheckinForum] : $t("app.text_2f18947d6a", { "id": id })).join("、");
            const gameNames = {
              genshin: $t("app.text_d1597c51ed"), honkai_sr: $t("app.text_a2927891f0"), zzz: $t("app.text_b1110352c9"), honkai2: $t("app.text_7deeae4b7e"), honkai3rd: $t("app.text_6d3d8653d7"), tears_of_themis: $t("app.text_a6e4fbed57"),
            } as const;
            const retryNames = (targets: Pick<NonNullable<typeof entry.communityRetry>, "forums" | "games">) => [
              targets.games?.length && $t("app.text_a1dbf4b05a", { "value1": targets.games.map(game => gameNames[game]).join("、") }),
              targets.forums.length && $t("app.text_1667f9f379", { "value1": forumNames(targets.forums) }),
            ].filter(Boolean).join("，");
            const lines: string[] = [];
            if (attempt) lines.push($t("app.text_4f57fb36e4", { "value1": attempt.games?.length ? $t("app.text_347fa28b3b") : $t("app.text_8997e1e17e"), "number": attempt.number, "profileId": entry.profileId }),
              $t("app.text_e4932b63de", { "value1": retryNames(attempt) }));
            if (entry.communityRetry?.verifiedUnsent) {
              const time = checkinScheduleClock(Date.parse(entry.communityRetry.nextAt)).iso.slice(11, 16);
              lines.push($t("app.text_e66d1a7402", { "time": time, "value2": retryNames(entry.communityRetry) }));
            } else if (attempt && !entry.ok) lines.push($t("app.text_e793dd6225"));
            const reply: MessageReply = lines.length
              ? [`${lines.join("\n")}\n`, ...(Array.isArray(result.reply) ? result.reply : [result.reply])] : result.reply;
            await deliverCheckin(entry.qq, entry.profileId, reply, result.revision);
          },
          async onNotice(entry, date, late, isCurrent) {
            const current = await checkinProfiles.checkinSettings(entry.qq, entry.profileId).catch(() => undefined);
            if (!current?.enabled || !current.notify.enabled || lifecycle.signal.aborted) return { status: "skipped" };
            const reply = await checkinPlanNotice(entry, date, current.displayName, late, lifecycle.signal);
            if (!reply) return { status: "skipped" };
            return deliverCheckin(entry.qq, entry.profileId, reply, current.revision, isCurrent);
          },
        });
        checkinRuntime = runtime;
        commands.registerModule(checkinBatchRetryCommands({
          profiles: checkinProfiles, signal: lifecycle.signal,
          async completedToday(qq, profileId) {
            const plan = await checkinScheduleStore.read(checkinScheduleClock().date);
            return plan?.entries.some(entry => entry.qq === qq && entry.profileId === profileId && entry.done && entry.ok === true) ?? false;
          },
          run: gameCheckin.runRegistered,
          async deliver(qq, profileId, reply, revision) {
            const result = await deliverCheckin(qq, profileId, reply, revision);
            if (result.status !== "confirmed" && result.status !== "unknown") throw new Error();
          },
        }));
        commands.registerModule(checkinRegistrationCommands(profileDirectory, lifecycle.signal, {
          canRegister: canRegisterCheckin, addRegisteredProfile: runtime.addRegisteredProfile,
          viewProfile,
        }));
        commands.registerModule(checkinGroupRegistrationCommands({
          profiles: checkinProfiles, signal: lifecycle.signal, canRegister: canRegisterGroup,
          async addRegisteredProfile(qq, profileId, revision) {
            const current = await checkinProfiles.checkinSettings(qq, profileId);
            if (lifecycle.signal.aborted) return;
            if (current.revision !== revision) throw new Error($t("app.text_8b47625d78"));
            await runtime.addRegisteredProfile({ qq, profileId, name: current.displayName, enabled: current.enabled, schedule: current.schedule });
          },
        }));
        commands.registerModule(checkinProfileCommands(profileDirectory, lifecycle.signal, {
          reconcilePlans: runtime.reconcileExistingPlans,
          viewProfile,
        }));
        commands.registerModule(checkinPlanCommands(checkinProfiles, runtime, lifecycle.signal,
          { canGenerate, canRunDue }));
        commands.registerModule(checkinScheduleSettingCommands(root, runtime, lifecycle.signal));
      } else {
        console.warn($t("app.text_64eebb4891"));
      }
    }
    commands.registerModule(passportLoginCommands(profileDirectory, lifecycle.signal, async (qq, profileId, revision) => {
      void generatedDevices.refresh(qq, profileId).catch(() => {
        if (!lifecycle.signal.aborted) console.warn($t("app.text_0edaecd48a"));
      });
      if (!checkinRuntime || lifecycle.signal.aborted) return;
      const current = await checkinProfiles.checkinSettings(qq, profileId);
      if (lifecycle.signal.aborted || !current.enabled || current.revision !== revision) return;
      await checkinRuntime.addRegisteredProfile({ qq, profileId, name: current.displayName, enabled: true, schedule: current.schedule });
    }));
    if (!probingUpdate) whenModuleTasksActive(() => {
      const active = AbortSignal.any([lifecycle.signal, handoffSession.signal]);
      const client = createProfileHoyoClient(checkinProfiles);
      scheduleLegacyPassportCookieRepair(active, async () => {
        const sweep = repairLegacyPassportCookies(checkinProfiles, client, nativeOperationSignal()).then(({ repaired, failed }) => {
          if (repaired || failed) console.info($t("app.text_9c150ffdff", { "repaired": repaired, "failed": failed }));
        }, () => console.warn($t("app.text_7fb28245b6")));
        pending.add(sweep);
        try { await sweep; }
        finally { pending.delete(sweep); }
      });
    });
    commands.registerModule({
      name: "@lotus-yunzai/gacha-batch", commands: {}, fallback: gachaBatch.fallback,
    }, $t("app.text_5f636b7036"));
    commands.registerModule({
      name: "@lotus-yunzai/panel-rebuild", commands: {}, fallback: panelRebuild.fallback,
    }, $t("app.text_f01182d86e"));
    const { hostname, oneBot, https, panelToken, panelPublicUrl } = network;
    const panelEnabled = panelToken !== undefined || panelPublicUrl !== undefined;
    panelOwnerSession = createPanelOwnerSession({
      databasePath: fileURLToPath(new URL("data/panel/owner-sessions.sqlite", root)),
      publicBase: () => panelEnabled ? panelPublicUrl ?? fileBase : undefined,
      isOwner: (bot, user) => masterPermissions.isMaster(bot, user),
      signal: lifecycle.signal,
      config: globalConfig.coin_shop,
      readLoginConfig: readWebLoginConfig,
    });
    commands.registerModule(panelOwnerSession.commands);
    const groupActions = {
      async noticeOwnerIds(botId: number, transport: AbortSignal) {
        const registration = ownerNoticeRecipients;
        const signal = registration ? nativeOperationSignal(registration.signal, transport) : nativeOperationSignal(transport);
        if (signal.aborted) return [];
        const all = await registration?.policy(botId, signal).catch(() => undefined);
        if (signal.aborted) return [];
        const owners = masterPermissions.masterIds(botId).filter(id => id !== botId);
        return all === false ? owners.slice(0, 1) : owners;
      },
      friendNoticeReceipts: probingUpdate ? undefined : friendNoticeReceipts,
      ownerFriendReplyClaim: probingUpdate ? undefined : ownerFriendReplyClaim,
      reserveFileNotice: (event: MessageEvent) => ownerMessageRelay.reserveFileNotice(event, allowsOwnerRelay(event)),
      canModerateGroups: () => !stopping && handoff.accepting && !dispatchPower.paused,
      canModeratePrivateGroup: (bot: number, group: number) => !stopping && handoff.accepting && !dispatchPower.paused &&
        groupDispatch.allowsScheduledGroup(bot, group, privateGroupNames),
      joinReview: probingUpdate ? undefined : groupJoinReview,
      groupWorkflowSignal: probingUpdate ? undefined : () => nativeOperationSignal(),
      isProtectedMaster: (bot: number, user: number) =>
        permissions.isMaster(bot, user) || permissions.legacyMasterIds().includes(user),
      onMemberMute(notice: MemberMuteNotice) {
        const handling = handleManagedWhitelist(notice).catch(() => console.warn($t("app.text_cf182ada84")));
        pending.add(handling);
        void handling.then(() => pending.delete(handling));
      },
      onTemporaryMessage(notice: NativeTemporaryMessageNotice) {
        const handling = forwardTemporaryMessage(notice).catch(() => {});
        pending.add(handling);
        void handling.then(() => pending.delete(handling));
      },
      onFriendRecall(notice: NativeFriendRecallNotice) {
        const handling = forwardFriendRecall(notice).catch(() => {});
        pending.add(handling);
        void handling.then(() => pending.delete(handling));
      },
      onGroupRecall(notice: NativeGroupRecallNotice) {
        const handling = forwardGroupRecall(notice).catch(() => {});
        pending.add(handling);
        void handling.then(() => pending.delete(handling));
      },
      onGroupMessageSource(source: NativeGroupMessageSource) {
        const text = typeof source.message === "string" ? source.message :
          source.message.map(part => part.type === "text" ? part.text : "").join("");
        const commandText = groupDispatch.commandText({
          msg: text, self_id: source.botId, group_id: source.groupId, message_type: "group",
        });
        if (containsArkRankTokenInput(source.message) || containsPanelTransferCapability(source.message) ||
            containsPanelSignatureChallenge(text) || isBotVerificationInput(commandText)) return;
        const capture = rememberGroupRecall(source);
        if (capture) {
          pending.add(capture);
          void capture.then(() => pending.delete(capture));
        }
        if (groupMessageNotice) {
          const handling = forwardGroupMessageNotice(source).catch(() => {});
          pending.add(handling);
          void handling.then(() => pending.delete(handling));
        }
      },
      onGroupOwnerMemberNotice(notice: NativeGroupOwnerMemberNotice) {
        const handling = forwardGroupOwnerMemberNotice(notice).catch(() => {});
        pending.add(handling);
        void handling.then(() => pending.delete(handling));
      },
      onGroupOwnerAdminNotice(notice: NativeGroupOwnerAdminNotice) {
        const handling = forwardGroupOwnerAdminNotice(notice).catch(() => {});
        pending.add(handling);
        void handling.then(() => pending.delete(handling));
      },
      onGroupOwnerBanNotice(notice: NativeGroupOwnerBanNotice) {
        const handling = forwardGroupOwnerBanNotice(notice).catch(() => {});
        pending.add(handling);
        void handling.then(() => pending.delete(handling));
      },
      onGroupOwnerGroupNotice(notice: NativeGroupOwnerGroupNotice) {
        const handling = forwardGroupOwnerGroupNotice(notice).catch(() => {});
        pending.add(handling);
        void handling.then(() => pending.delete(handling));
      },
    };
    const milkyNoticeReceipts = waitForMilkyNoticeReceipts(lifecycle.signal);
    const milkyOptions: MilkyTransportOptions = {
      ...groupActions,
      signal: milkyNoticeReceipts.signal,
      dispatch,
      accepting: () => !stopping && !lifecycle.signal.aborted && handoff.accepting,
      onNoticeAttempt: milkyNoticeReceipts.track,
      friendReview,
      invitationReview,
      invitationReceipts,
      onSent: (event, message) => recordCount("send", event, message),
      masterIds: permissions.masterIds,
      onOnline: (botId, signal, send, checkinNotify, ownGroupCardAccount, timedWholeMute, noticeAccount, uploadFile) => {
        milkyOnline = { id: botId, startedAt: performance.now(), signal, send, checkinNotify, ownGroupCardAccount, timedWholeMute,
          noticeAccount, uploadFile };
        queueStartupMessages(botId, "milky", signal);
      },
      isMaster: permissions.isMaster,
      groupReviews: milky && createMilkyGroupReviews(),
    };
    const milkyWebhook = milky?.connection === "webhook" ? createMilkyWebhook(milky, milkyOptions) : undefined;
    const milkyWs = milky?.connection === "ws" ? createMilkyWs(milky, milkyOptions) : undefined;
    const milkyTransport = milkyWebhook ?? milkyWs;
    if (milkyWebhookPath) legacy.httpRoutes.reserve(milkyWebhookPath);
    if (miyousheWeb) legacy.httpRoutes.reserveMount(miyousheWeb.mount);
    stopMilky = milkyTransport && (async () => {
      await milkyNoticeReceipts.closed;
      await milkyTransport.stop();
    });
    const http = network.http ?? (milkyWebhook && !https ? { port: 2536, auth: new Headers() } : undefined);
    if (network.manualCaptchaUrl && !probingUpdate) {
      if (!http && !https) {
        console.warn($t("app.text_856913940e"));
      } else {
        try {
          const { createManualCaptchaRelay } = await import("./lib/captcha/manual-relay.ts");
          manualCaptcha = createManualCaptchaRelay({ publicUrl: network.manualCaptchaUrl });
        } catch {
          console.warn($t("app.text_7d2f283c5f"));
        }
      }
    }
    // Plugins may create file links during initialization. Keep the bound listeners guarded until routes are ready.
    let publicRoutes: ((request: Request, auth: Headers) => Promise<Response | undefined>) | undefined;
    const acceptingPublic = () => !stopping && handoff.accepting && publicRoutes !== undefined;
    const listenerMessages: string[] = [];
    let updateProbePort: number | undefined;
    function httpHandler(auth: Headers) {
      const statusRoute = httpStatus(auth, runtimeVersion);
      return async (request: Request, server?: { requestIP(request: Request): { address: string } | null }) => {
        const publicConfigured = [...auth.keys()].length > 0 || network.publicUrl || network.panelPublicUrl || network.manualCaptchaUrl || network.https?.publicUrl;
        if (!publicConfigured && !isDirectInternalRequest(request, server?.requestIP(request)?.address)) return new Response(null, { status: 403 });
        if (stopping || !handoff.accepting || !publicRoutes) return new Response(null, { status: 503 });
        return await publicRoutes(request, auth) ?? statusRoute(request);
      };
    }
    function listenOneBot(port: number, auth: Headers, fetch?: ReturnType<typeof httpHandler>, tls?: Bun.TLSOptions) {
      const server = startOneBot(dispatch, {
        ...groupActions,
        friendRequestReviewClaim: probingUpdate ? undefined : friendReview,
        invitationReviewClaim: probingUpdate ? undefined : invitationReview,
        hostname, port, auth, groups, isMaster: permissions.isMaster, masterIds: permissions.masterIds,
        onFriendRelationship(notice) {
          const handling = forwardFriendRelationship(notice).catch(() => {});
          pending.add(handling);
          void handling.then(() => pending.delete(handling));
        },
        prewarmGroupMembers: botConfig.cache_group_member === undefined || Boolean(botConfig.cache_group_member),
        accepting: acceptingPublic,
        onBind: (botId, signal) => queueStartupMessages(botId, undefined, signal),
        onLegacySignal(event, signal) {
          if (!legacyBot || stopping || !handoff.accepting) return;
          const active = AbortSignal.any([lifecycle.signal, handoffSession.signal, signal]);
          if (active.aborted) return;
          if (event.post_type === "system") console.info(`[${event.self_id}] ${event.tag}：${event.message}`);
          else {
            if (!groupDispatch.allowsInbound({ self_id: event.self_id, user_id: event.user_id })) return;
            console.info(`[${event.self_id}] ${sanitizeRuntimeLog(event.message, 512)}`);
          }
          legacy.exitHooks.emit(legacyBot, event, active);
        },
        onSent: valkey === undefined ? undefined : (identity, message) => recordCount("send", identity, message),
        http: fetch,
        tls,
      });
      servers.push(server);
      for (const origin of listenerOrigins(hostname, server.port, tls ? "wss" : "ws"))
        listenerMessages.push($t("app.text_773cdeec59", { "origin": origin }));
      listenerMessages.push([...auth.keys()].length ? $t("app.text_d380ecab16") : $t("app.text_29dee9c0ea"));
      return server;
    }
    function listenHttp(port: number, fetch: ReturnType<typeof httpHandler>, tls?: Bun.TLSOptions) {
      const server = Bun.serve({ hostname, port, fetch, tls });
      servers.push(server);
      return server;
    }
    const shared = http !== undefined && oneBot !== undefined && http.port === oneBot.port;
    const socketServer = oneBot && listenOneBot(oneBot.port, oneBot.auth, shared ? httpHandler(http.auth) : undefined);
    if (http) {
      const server = shared && socketServer ? socketServer : listenHttp(http.port, httpHandler(http.auth));
      if (updateProbeToken && hostname === "127.0.0.1" && server.url.hostname === "127.0.0.1") updateProbePort = server.port;
      fileBase = network.publicUrl ?? listenerFileBase(server.url.hostname, server.port);
      for (const origin of listenerOrigins(hostname, server.port, "http"))
        listenerMessages.push($t("app.text_711c38353a", { "origin": origin }));
    }
    if (network.httpsError && !probingUpdate) console.warn($t("app.text_206037e4ca"));
    let tlsListener: ManagedTlsListener | undefined;
    let tlsPort: number | undefined;
    if (https && !probingUpdate) {
      try {
        const [key, cert] = await Promise.all([readFile(https.key), readFile(https.cert)]);
        if (!stopping) {
          const tls = { key, cert };
          const fetch = httpHandler(https.auth);
          const oneBotAuth = https.oneBotAuth;
          const port = https.port;
          const server = oneBotAuth
            ? listenOneBot(port, oneBotAuth, fetch, tls)
            : listenHttp(port, fetch, tls);
          tlsListener = oneBotAuth ? "wss" : "https";
          tlsPort = port;
          fileBase = https.publicUrl ?? fileBase ?? network.publicUrl ?? listenerFileBase(server.url.hostname, server.port, "https");
          for (const origin of listenerOrigins(hostname, server.port, "https"))
            listenerMessages.push($t("app.text_82bd220a04", { "origin": origin }));
        }
      } catch {
        if (!stopping) console.warn($t("app.text_8eeae42aa2"));
      }
    }
    if (milkyWebhook && !http && !tlsListener) {
      throw new Error($t("app.text_460c4c2d34"));
    }
    lifecycle.signal.throwIfAborted();
    const fileToUrl = createFileToUrl(publicFiles, botConfig, () => stopping ? undefined : fileBase);
    const imageToUrl = createImageToUrl(fileToUrl, Bun.env.LOTUS_PUBLIC_IMAGE_DIR?.trim());
    const makeLog = createPluginLog(botConfig, runtimeLog?.writePluginLog);
    Object.assign(globalThis, { logger: runtimePluginLogger(botConfig, runtimeLog?.writePluginLog) });
    legacyBot = Object.freeze({
      fileToUrl, imageToUrl, makeLog, express: legacy.httpRoutes.express,
      on(event: unknown, listener: unknown) {
        legacy.exitHooks.add(event, listener);
        return this;
      },
      once(event: unknown, listener: unknown) {
        legacy.exitHooks.add(event, listener, true);
        return this;
      },
      off(event: unknown, listener: unknown) {
        legacy.exitHooks.remove(event, listener);
        return this;
      },
      get uin() {
        const sessions = groups.onlineBindings();
        const milky = milkyOnline;
        if (milky && !milky.signal.aborted) sessions.push({ id: milky.id, startedAt: milky.startedAt });
        sessions.sort((left, right) => left.startedAt - right.startedAt);
        return Object.freeze([...new Set(sessions.map(({ id }) => id))]);
      },
      get bots() {
        const sessions = groups.onlineProfiles();
        const milky = milkyOnline;
        if (milky && !milky.signal.aborted) sessions.push({ id: milky.id, startedAt: milky.startedAt,
          nickname: memberDisplayName(milky.ownGroupCardAccount.nickname) });
        sessions.sort((left, right) => left.startedAt - right.startedAt);
        const profiles: Record<number, { readonly nickname: string }> = Object.create(null);
        for (const { id, nickname } of sessions) {
          if (nickname !== undefined && !Object.hasOwn(profiles, id)) profiles[id] = Object.freeze({ nickname });
        }
        return Object.freeze(profiles);
      },
    });
    Object.assign(globalThis, { Bot: legacyBot });
    const loadTimeout = parsePluginLoadMilliseconds(botConfig.plugin_load_timeout);
    if (loadTimeout === undefined) console.warn($t("app.text_aa5ff0ae8b"));
    const storedLikeAssets = new URL("data/group/like-assets/", root);
    const likeAssets = Bun.env.LOTUS_GROUP_LIKE_ASSETS_DIR?.trim() ||
      (await stat(storedLikeAssets).then(info => info.isDirectory(), () => false)
        ? fileURLToPath(storedLikeAssets) : builtinResourceDirectory("social/likes", root));
    const groupTransport = groups.transport();
    const noticeActive = () => handoff.accepting && !stopping && !lifecycle.signal.aborted;
    commands.registerModule(legacyCharacterAliases);
    plugins = await loadPlugins(fileURLToPath(new URL("plugins", root)), commands, legacy, Object.freeze({
      groups: groupTransport, signal: lifecycle.signal, fileToUrl, lockFile, subscriptionTransport, execute: commandDelegation.execute,
      allowOfficialVideoGroup: (botId: number, groupId: number) => noticeActive() &&
        groupDispatch.allowsScheduledGroup(botId, groupId, [$t("app.text_ab8c7809cd"), "media", "@lotus-yunzai/media"]),
      messageStatistics: createMessageStatistics(counts),
      runtimeVersion,
      readCharacterAliases: (game: "gi" | "hsr") =>
        readGameCharacterAliases(game === "gi" ? "gs" : "sr", fileURLToPath(root), { includePreset: true }),
      statusPhotoStorage: statusStorage("status-photo"),
      statusMonitorStorage: statusStorage("status-monitor"),
      statusMonitorRedisClients: valkey === undefined ? undefined : (signal: AbortSignal) =>
        readRuntimeStatusRedisClients(request => globalThis.redis
          ? readStorageCommand<string>(globalThis.redis, ["INFO", "clients"], request) : Promise.resolve(""), signal),
      runtimeStatus: createRuntimeStatus({
        accounts() {
          const accounts = groups.onlineAccounts().map(account => ({ ...account, adapter: "onebot" as const }));
          const online = milkyOnline;
          if (!online || online.signal.aborted) return accounts;
          return [...accounts, { id: online.id, adapter: "milky" as const,
            seconds: Math.max(0, Math.floor((performance.now() - online.startedAt) / 1_000)) }];
        },
        readCounts: counts.read,
        countImages: segmentCounts,
        readRedisStatus: valkey === undefined ? undefined : (signal) =>
          globalThis.redis ? readStorageCommand<string>(globalThis.redis, ["INFO"], signal) : Promise.resolve(""),
        loadedNames: () => plugins?.records.filter(record => record.status === "loaded").map(record => record.name),
      }),
      runtimeDiagnostics(context: CommandContext) {
        const online = milkyOnline;
        const terminal = context.message_type === "terminal";
        const milkyDiagnostics = context.runtimeDiagnosticsScope === "milky";
        if (!context.isMaster && !milkyDiagnostics) return { accounts: [], plugins: [] };
        const milkyAccount = (terminal || milkyDiagnostics) && online && !online.signal.aborted ? {
          id: online.id, adapter: "milky" as const,
          seconds: Math.max(0, Math.floor((performance.now() - online.startedAt) / 1_000)),
        } : undefined;
        if (milkyDiagnostics) {
          const { message_type, self_id, user_id } = context;
          if (message_type !== "private" || !milkyAccount || self_id !== milkyAccount.id || user_id === undefined ||
              !permissions.isMaster(self_id, user_id)) return;
          return { accounts: [milkyAccount], plugins: plugins?.timings ?? [] };
        }
        const accounts = groups.onlineAccounts();
        return {
          accounts: milkyAccount ? [...accounts, milkyAccount] : terminal ? accounts : accounts.filter(({ id }) => id === context.self_id),
          plugins: plugins?.timings ?? [],
        };
      },
    }), {
      loadTimeout, reportLoading, fileWatch: botConfig.file_watch !== false && !probingUpdate, registerGacha: gachaBatch.register,
      registerPanelRebuild: panelRebuild.register,
      hostReplacementModules: [gachaExpectationModuleName],
      noticeServices: {
        whenNoticeActive: probingUpdate ? () => () => {} : whenModuleTasksActive,
        noticeGroups: noticeGroupTransport(groupTransport,
          () => noticeActive() ? groups.noticeAccounts() : [],
          () => {
            const online = milkyOnline;
            return noticeActive() && online && !online.signal.aborted ? online.noticeAccount : undefined;
          }),
        disconnect: handoffSession.signal,
      },
      groupServices: probingUpdate ? undefined : {
        noticeSettingsThemeDirectory: Bun.env.LOTUS_GROUP_NOTICE_THEME_DIR?.trim() || fileURLToPath(new URL("data/group/notice-theme/", root)),
        ownGroupCardAccounts() {
          const accounts = groups.ownGroupCardAccounts();
          const milky = milkyOnline?.ownGroupCardAccount;
          return milky && !milky.signal.aborted ? [...accounts, milky] : accounts;
        },
        registerAutoGroupCardTask(cron, run) {
          return registerModuleTask($t("app.text_c428ee8a83"), cron, run);
        },
        groupTimedMute: {
          async readLegacy() { return await globalThis.redis?.get("yenai:MuteTasks") ?? null; },
          validateCron: validateModuleCron,
          register(name, cron, run) {
            if (!validateModuleCron(cron)) throw new Error($t("app.text_11f8d782a8"));
            return registerModuleTask(name, cron, run);
          },
          async execute(binding, signal) {
            const active = nativeOperationSignal(signal);
            const { botId, groupId, issuerId } = binding;
            if (active.aborted || stopping || !handoff.accepting || dispatchPower.paused ||
                !groupDispatch.allowsScheduledGroup(botId, groupId, timedGroupMuteNames)) return "unavailable";
            if (binding.adapter === "onebot") {
              return groups.timedWholeMute(binding, active, () => permissions.isMaster(botId, issuerId));
            }
            const session = milkyOnline;
            if (!session || session.id !== botId || session.signal.aborted) return "unavailable";
            return session.timedWholeMute(binding, active);
          },
          report(binding, result) {
            if (result === "unknown") console.warn($t("app.text_2b0a45980d", { "groupId": binding.groupId }));
          },
        },
        autoRepeatSessionSignal(value) {
          if (!value || typeof value !== "object") return;
          const event = value as MessageEvent;
          if (event.message_type !== "group" || event.isDelegated) return;
          const signal = event[delegationSession]?.signal;
          if (signal?.aborted === false) return signal;
        },
        observeAutoRepeat(group, observe) {
          const handling = groupRepeatOrder.observe(group, observe);
          if (!handling) return observe();
          pending.add(handling);
          void handling.catch(() => console.warn($t("app.text_207c649543"))).finally(() => pending.delete(handling));
        },
        readAutoRepeatImage: readQqMessageMedia,
        async profileLikeImage(userId, outcome, signal) {
          if (signal.aborted || stopping || !handoff.accepting) return;
          const image = await likeImageRenderer?.(userId, outcome, nativeOperationSignal(signal));
          if (image) return markGeneratedImage(image);
        },
        registerManagedBlacklist(policy) {
          const session = new AbortController();
          const registration = { policy, signal: session.signal };
          managedBlacklist = registration;
          return () => {
            session.abort();
            if (managedBlacklist === registration) managedBlacklist = undefined;
          };
        },
        registerGroupBannedWords(policy) {
          const session = new AbortController();
          const registration = { policy, signal: session.signal };
          groupBannedWords = registration;
          return () => {
            session.abort();
            if (groupBannedWords === registration) groupBannedWords = undefined;
          };
        },
        registerGroupAddNotice(policy) {
          const session = new AbortController();
          const registration = { policy, signal: session.signal };
          groupAddNotice = registration;
          return () => {
            session.abort();
            if (groupAddNotice === registration) groupAddNotice = undefined;
          };
        },
        registerFriendRequestNotice(policy) {
          const session = new AbortController();
          const registration = { policy, signal: session.signal };
          friendRequestNotice = registration;
          return () => {
            session.abort();
            if (friendRequestNotice === registration) friendRequestNotice = undefined;
          };
        },
        registerFriendMessageNotice(policy) {
          const session = new AbortController();
          const registration = { policy, signal: session.signal };
          friendMessageNotice = registration;
          return () => {
            session.abort();
            if (friendMessageNotice === registration) friendMessageNotice = undefined;
          };
        },
        registerTemporaryMessageNotice(policy) {
          const session = new AbortController();
          const registration = { policy, signal: session.signal };
          temporaryMessageNotice = registration;
          return () => {
            session.abort();
            if (temporaryMessageNotice === registration) temporaryMessageNotice = undefined;
          };
        },
        registerFriendRelationshipNotice(policy) {
          const session = new AbortController();
          const registration = { policy, signal: session.signal };
          friendRelationshipNotice = registration;
          return () => {
            session.abort();
            if (friendRelationshipNotice === registration) friendRelationshipNotice = undefined;
          };
        },
        registerFriendPokeNotice(policy) {
          const session = new AbortController();
          const registration = { policy, signal: session.signal };
          friendPokeNotice = registration;
          return () => {
            session.abort();
            if (friendPokeNotice === registration) friendPokeNotice = undefined;
          };
        },
        registerFriendRecallNotice(policy) {
          const session = new AbortController();
          const registration = { policy, signal: session.signal };
          friendRecallNotice = registration;
          return () => {
            session.abort();
            if (friendRecallNotice === registration) friendRecallNotice = undefined;
          };
        },
        registerGroupRecallNotice(policy) {
          const session = new AbortController();
          const registration = { policy, signal: session.signal };
          groupRecallNotice = registration;
          return () => {
            session.abort();
            if (groupRecallNotice === registration) groupRecallNotice = undefined;
          };
        },
        registerGroupMessageNotice(policy) {
          const session = new AbortController();
          const registration = { policy, signal: session.signal };
          groupMessageNotice = registration;
          return () => {
            session.abort();
            if (groupMessageNotice === registration) groupMessageNotice = undefined;
          };
        },
        registerGroupOwnerMemberNotice(policy) {
          const session = new AbortController();
          const registration = { policy, signal: session.signal };
          groupOwnerMemberNotice = registration;
          return () => {
            session.abort();
            if (groupOwnerMemberNotice === registration) groupOwnerMemberNotice = undefined;
          };
        },
        registerGroupOwnerAdminNotice(policy) {
          const session = new AbortController();
          const registration = { policy, signal: session.signal };
          groupOwnerAdminNotice = registration;
          return () => {
            session.abort();
            if (groupOwnerAdminNotice === registration) groupOwnerAdminNotice = undefined;
          };
        },
        registerGroupOwnerBanNotice(policy) {
          const session = new AbortController();
          const registration = { policy, signal: session.signal };
          groupOwnerBanNotice = registration;
          return () => {
            session.abort();
            if (groupOwnerBanNotice === registration) groupOwnerBanNotice = undefined;
          };
        },
        registerGroupOwnerGroupNotice(policy) {
          const session = new AbortController();
          const registration = { policy, signal: session.signal };
          groupOwnerGroupNotice = registration;
          return () => {
            session.abort();
            if (groupOwnerGroupNotice === registration) groupOwnerGroupNotice = undefined;
          };
        },
        registerGroupOwnerJoinRequestNotice(policy) {
          const session = new AbortController();
          const registration = { policy, signal: session.signal };
          groupOwnerJoinRequestNotice = registration;
          return () => {
            session.abort();
            if (groupOwnerJoinRequestNotice === registration) groupOwnerJoinRequestNotice = undefined;
          };
        },
        registerGroupOwnerInvitationNotice(policy) {
          const session = new AbortController();
          const registration = { policy, signal: session.signal };
          groupOwnerInvitationNotice = registration;
          return () => {
            session.abort();
            if (groupOwnerInvitationNotice === registration) groupOwnerInvitationNotice = undefined;
          };
        },
        registerOwnerNoticeRecipients(policy) {
          const session = new AbortController();
          const registration = { policy, signal: session.signal };
          ownerNoticeRecipients = registration;
          return () => {
            session.abort();
            if (ownerNoticeRecipients === registration) ownerNoticeRecipients = undefined;
          };
        },
        registerGroupVerification(policy) {
          const session = new AbortController();
          const registration = { policy, signal: session.signal };
          groupVerification = registration;
          return () => {
            session.abort();
            if (groupVerification === registration) groupVerification = undefined;
          };
        },
        groupLeaveBlacklist: {
          register(policy) {
            const session = new AbortController();
            const registration = { policy, signal: session.signal };
            leaveBlacklist = registration;
            return () => {
              session.abort();
              if (leaveBlacklist === registration) leaveBlacklist = undefined;
            };
          },
          io: {
            async get(groupId, userId) {
              if (!globalThis.redis) throw new Error($t("app.text_5459de4f75"));
              return await globalThis.redis.hGet(`Yz:group-leave-blacklist:${groupId}`, String(userId)) ?? null;
            },
            async set(groupId, userId, json) {
              if (!globalThis.redis) throw new Error($t("app.text_5459de4f75"));
              await globalThis.redis.hSet(`Yz:group-leave-blacklist:${groupId}`, String(userId), json);
            },
            async remove(groupId, userId) {
              if (!globalThis.redis) throw new Error($t("app.text_5459de4f75"));
              return (await globalThis.redis.hDel(`Yz:group-leave-blacklist:${groupId}`, String(userId))) > 0;
            },
            async appendGlobal(userId, signal) {
              try {
                const outcome = await appendBlackUser(root, userId, () => !signal.aborted && !stopping && handoff.accepting);
                if (outcome !== "protected") groupDispatch.blockUser(userId);
                return outcome;
              } catch {
                return "unavailable";
              }
            },
            isProtected(userId) {
              return masterPermissions.legacyMasterIds().includes(userId) ||
                masterPermissions.botIds().some(botId => masterPermissions.isMaster(botId, userId));
            },
            report(stage, outcome) {
              if (outcome !== "confirmed") console.warn($t("app.text_dbb19f5af0", { "stage": stage }));
            },
          },
        },
      },
      memeRuntime: probingUpdate ? undefined : {
        whenReady: whenModuleTasksActive,
        async loadInfoCard() {
          const info = await import("@lotus-yunzai/skia/info-card");
          const configured = Bun.env.LOTUS_SKIA_MODE;
          const mode = configured === "gpu" || configured === "cpu" ? configured : "auto";
          return { ...info, renderInfoCard: (header, buildBody, options) => info.renderInfoCard(header, buildBody, { ...options, mode }) };
        },
      },
      mediaRuntime: probingUpdate ? undefined : {
        disconnect: handoffSession.signal,
        whenReady: whenModuleTasksActive,
        registerTask: (cron, run) => registerModuleTask($t("app.text_f4e425d817"), cron, run),
        registerOfficialVideoTask: (cron: string, run: () => Promise<void>) =>
          registerModuleTask($t("app.text_ab8c7809cd"), cron, run),
        async notifyMasters(reply, signal) {
          const active = signal ? nativeOperationSignal(signal) : nativeOperationSignal();
          const notified = new Set<number>();
          for (const session of subscriptionTransport()) {
            for (const userId of masterPermissions.masterIds(session.botId)) {
              if (!handoff.accepting || stopping || active.aborted) return;
              if (userId === session.botId || notified.has(userId)) continue;
              const result = await notifyCheckin({
                userId, reply, transports: [session], signal: active,
                settings: { enabled: true, prefer: "private", fallbackGroups: [] },
                async verifySend() {
                  return handoff.accepting && !stopping && masterPermissions.isMaster(session.botId, userId);
                },
              });
              if (result.status === "confirmed" || result.status === "unknown") notified.add(userId);
            }
          }
        },
      },
      hoyoTransport,
      async zzzPanelRankRoles(source, options) {
        const { roles } = await zzzRankClient.openHoYoLabZzzCheckin(source, options);
        return { roles };
      },
      panelCacheRuntime: probingUpdate ? undefined : {
        disconnect: handoffSession.signal,
        register: (game, run) => registerModuleTask($t(game === "gs" ? "app.gs-panel-cache-task" : "app.sr-panel-cache-task"), "0 0 * * * *", run, true),
      },
      zzzReminderRuntime: probingUpdate ? undefined : {
        registerPanelCacheTask: run => registerModuleTask($t("app.zzz-panel-cache-task"), "0 0 * * * *", run, true),
        disconnect: handoffSession.signal,
        registerTask: run => registerModuleTask($t("app.text_0e17df94d9"), "0 * * * * *", run, true),
        route: (userId, botId, signal) => resolvePrivateFriendRoute(subscriptionTransport, userId, botId,
          () => !signal.aborted && !lifecycle.signal.aborted && handoff.accepting && !stopping, () => masterPermissions.botIds()),
      },
      profileLikeImages: probingUpdate ? undefined : {
        directory: likeAssets,
        rasterScale: nativeImageRasterScale(),
        register(renderer) {
          likeImageRenderer = renderer;
          return () => {
            if (likeImageRenderer === renderer) likeImageRenderer = undefined;
          };
        },
      },
      guidesSchedule: probingUpdate ? undefined : {
        register(policy) {
          const session = new AbortController();
          const registration = { policy, signal: session.signal };
          calendarSchedule = registration;
          return () => {
            session.abort();
            if (calendarSchedule === registration) calendarSchedule = undefined;
          };
        },
        registerTask: (cron, type, run) => registerModuleTask($t("app.text_a292b98594", { "type": type }), cron, run),
        targets: scheduledCalendarTargets,
        whenReady: whenModuleTasksActive,
      },
      roleQFace: (globalConfig.atlas as { readonly role_q_face?: unknown } | undefined)?.role_q_face !== false,
      atlasUpdate: probingUpdate ? undefined : {
        config: globalConfig.atlas,
        register(schedule) {
          const jobs: (() => Promise<void>)[] = [];
          for (const [kind, name] of [["version", $t("app.text_41650baaa0")], ["challenge", $t("app.text_a007b52646")]] as const) {
            const task = schedule[kind];
            if (task?.issue) console.warn(`${name} ${task.issue}`);
            if (typeof task?.cron !== "string" || typeof task.run !== "function") continue;
            jobs.push(registerModuleTask(name, task.cron, async () => {
              const summary = await task.run();
              if (summary) console.log(`${name}\n${summary}`);
            }));
          }
          return async () => { await Promise.all(jobs.map(stopJob => stopJob())); };
        },
      },
    });
    if (!stopping) {
      commands.registerModule(weatherCommands(lifecycle.signal), $t("app.text_4d94732547"));
      commands.registerModule(generalToolCommands(lifecycle.signal), $t("app.text_ddd4873754"));
      if (!commands.hasModule(systemModuleName)) {
        throw new Error($t("app.text_203fa3ba02"));
      }
      if (!probingUpdate && commands.hasModule("@lotus-yunzai/atlas")) {
        const gallery = createCharacterGallerySchedule({
          readConfig: () => readLotusGlobalConfig(root),
          async synchronize(signal) {
            const { syncCharacterGallery } = await import("./lib/character-gallery-sync.ts");
            return runInitializationStage($t("app.text_9e5f324e0b"), onProgress => syncCharacterGallery({
              root: fileURLToPath(new URL("data/character-gallery-synced/", root)), signal, onProgress,
            }), { label: $t("app.text_0091a6122f"), signal });
          },
          report: ({ downloaded, reused, removed }) => {
            console.info($t("app.text_4d875465d3", { "downloaded": downloaded, "reused": reused, "removed": removed }));
          },
          reportFailure: error => {
            console.warn($t("app.text_272a67ecd6"), error instanceof Error ? error.message : "");
          },
        });
        registerModuleTask($t("app.text_fe776efa19"), characterGalleryCron,
          () => gallery.run(nativeOperationSignal()));
      }
      const fallback = createServerRedirect(network.redirect);
      const settingsRoutes = new Map<string, ReturnType<typeof panelWebLogin>>([
        ["/panel/api/i18n", panelI18n(i18nSettings)],
        ["/panel/api/i18n/apply", async (request, authorized) => {
          if (!authorized() || request.signal.aborted) return new Response(null, { status: 401 });
          if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
          const timer = setTimeout(() => { if (authorized() && !lifecycle.signal.aborted) void startProcessAction("restart", []); }, 250);
          timer.unref();
          return Response.json({ restarting: true });
        }],
        ["/panel/api/settings/checkin/schedule", panelCheckinSchedule(root)],
        ["/panel/api/settings/checkin/permissions", panelAccountPermissions(root)],
        ["/panel/api/settings/group/export-permissions", panelGroupExportPermissions(root)],
        ["/panel/api/settings/global/permissions", panelGlobalPermissions(root)],
        ["/panel/api/settings/atlas/channel", panelAtlasChannel(root)],
        ["/panel/api/settings/atlas/gallery", panelAtlasGallery(root)],
        ["/panel/api/settings/native/rank", panelGroupRankSettings(root)],
        ["/panel/api/settings/native/status", panelStatusSettings(root)],
        ["/panel/api/settings/native/runtime", panelRuntimeSettings(root)],
        ["/panel/api/settings/native/remote", panelRemoteSettings(root)],
        [arkRankCredentialsPath, arkRankCredentials.panel],
        ["/panel/api/settings/native/process-schedule", panelProcessScheduleSettings(root, validateModuleCron, updateNotices.apply)],
        ["/panel/api/settings/native/daily-note", panelDailyNoteSettings(root, validateModuleCron)],
        ["/panel/api/settings/native/showcase", panelGameSettings(root, "showcase")],
        ["/panel/api/settings/native/genshin-damage", panelGameSettings(root, "genshin-damage")],
        ["/panel/api/settings/native/starrail-warp", panelStarRailWarpSettings(root)],
        ["/panel/api/settings/native/starrail-independent-warp", panelStarRailIndependentWarp(root)],
        ["/panel/api/settings/native/gacha-display", panelGachaSettings(root)],
        ["/panel/api/settings/native/genshin-wish", panelGenshinWishSettings(root)],
        ["/panel/api/settings/native/zzz-rank", panelZzzSettings(root)],
        ["/panel/api/settings/native/zzz-panel", panelZzzSettings(root, "panel")],
        ["/panel/api/settings/native/zzz-reminders", panelZzzSettings(root, "reminders")],
        ["/panel/api/settings/native/ingress", panelIngressSettings(root,
          () => Promise.all([groupDispatch.refreshLists(), privateAccess.refresh(true), otherPolicies.refresh(true)]))],
        ["/panel/api/settings/native/group-routing", panelGroupRouting(root, groupDispatch.refreshGroups)],
        ["/panel/api/settings/native/guides", panelGuidesSettings(root)],
        ["/panel/api/settings/native/genshin-guides", panelGenshinGuideSettings(root)],
        ["/panel/api/settings/native/starrail-guides", panelStarRailGuideSettings(root)],
        ["/panel/api/settings/native/zzz-guides", panelZzzGuideSettings(root)],
        ["/panel/api/settings/native/calendar", panelGuideCalendarSettings(() => calendarSchedule?.policy)],
        ["/panel/api/settings/native/notice", panelNoticeSettings(root)],
        ["/panel/api/settings/native/mys-notice", panelNoticeMysSettings(root, validateModuleCron)],
        ["/panel/api/settings/native/notice-delivery", panelNoticeDeliverySettings(() => globalThis.redis, () => groupTransport.onlineBots())],
        ["/panel/api/settings/atlas/update", panelAtlasUpdate(root, validateModuleCron)],
        ["/panel/api/settings/web/login", panelWebLogin(root, milkyWebhookPath)],
        ["/panel/api/settings/group/likes", panelGroupSettings(root, plugins.directories)],
        ["/panel/api/settings/group/notices", panelGroupNoticeSettings(root, plugins.directories)],
        ["/panel/api/settings/native/group-moderation", panelGroupManagement(root, plugins.directories, "groupAdmin", validateModuleCron)],
        ["/panel/api/settings/native/group-card", panelGroupManagement(root, plugins.directories, "auto-group-card", validateModuleCron)],
        ["/panel/api/settings/native/group-leave-blacklist", panelGroupManagement(root, plugins.directories, "group-leave-blacklist", validateModuleCron)],
        ["/panel/api/settings/group/cleanup", panelGroupCleanup(root)],
      ]);
      if (plugins.records.some(plugin => plugin.name === "media" && plugin.status === "loaded")) {
        settingsRoutes.set("/panel/api/settings/media/music", panelMusic(root));
        settingsRoutes.set("/panel/api/settings/media/bilibili", panelBilibili(root));
        settingsRoutes.set("/panel/api/settings/media/douyin", panelDouyin(root));
        settingsRoutes.set("/panel/api/settings/media/partner", panelPartner(root, validateModuleCron));
        settingsRoutes.set("/panel/api/settings/media/environment", panelMediaEnvironment(root));
        settingsRoutes.set("/panel/api/settings/media/download-permissions", panelMediaDownloadPermissions(root));
        settingsRoutes.set("/panel/api/settings/media/preview-permissions", panelMediaPreviewPermissions(root));
        settingsRoutes.set("/panel/api/settings/media/owner-permissions", panelMediaOwnerPermissions(root));
        for (const platform of ["bilibili", "weibo"] as const) {
          settingsRoutes.set(`/panel/api/settings/native/${platform}-subscriptions`, async (request, authorized) => {
            const { panelMediaSubscriptionSettings } = await import("./plugins/media/services/subscriptions/panel.ts");
            return panelMediaSubscriptionSettings(root, platform, input => panelOwnerSession?.contactSession(input))(request, authorized);
          });
        }
      }
      const guoba = panelGuobaRoutes(plugins.directories);
      const extensions = !panelEnabled ? undefined : panelExtensionRoutes(plugins.directories,
        network.webMount && webMountPage(network.webMount, lifecycle.signal), { loadTimeout, signal: lifecycle.signal });
      const panel = !panelEnabled ? undefined : panelApi(panelToken, plugins.records,
        (path) => settingsRoutes.get(path) ?? guoba(path) ?? extensions?.api(path), runtimeVersion, panelOwnerSession);
      const assets = panel && panelAssets(fileURLToPath(new URL("panel/dist", root)));
      publicRoutes = async (request, auth) => {
        if (new URL(request.url).pathname === panelTransferPath) {
          return panelTransfer?.source.serve(request) ?? new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
        }
        return await manualCaptcha?.handlePublic(request) ?? publicFiles.handle(request) ?? mediaDelivery.handle(request) ??
          await miyousheWeb?.handle(request) ?? await panel?.(request) ?? await extensions?.assets(request) ?? await assets?.(request) ??
          await milkyWebhook?.handle(request, auth) ?? await legacy.httpRoutes.handle(request, auth, acceptingPublic) ?? fallback?.(request);
      };
      if (updateProbeToken && updateProbePort !== undefined && process.connected === true && typeof process.send === "function") {
        try { process.send({ type: "lotus-yunzai-probe-listener", token: updateProbeToken, host: "127.0.0.1", port: updateProbePort }); }
        catch { /* The isolated probe may have already disconnected during cancellation. */ }
      }
      for (const message of listenerMessages) console.info(formatTerminalLog("mark", message));
      await handoff.ready(runtimeVersion.revision, lifecycle.signal, plugins.readyDirectories, {
        // Port 0 is an ephemeral binding and may get a different allocated port on each process.
        httpPort: http?.port, oneBotPort: socketServer ? oneBot?.port : undefined, tls: tlsListener, tlsPort,
        milky: milkyTransport && milky?.connection, valkey: valkey === undefined ? undefined : true,
      }, plugins.readyScripts, valkey ?? null);
      legacyProcessReady = handoff.accepting && !lifecycle.signal.aborted;
      if (recordedPause !== undefined) handoff.reportPower(dispatchPower.pausedAt);
      if (legacyPause && !lifecycle.signal.aborted && handoff.accepting) {
        try {
          durablePause?.save(legacyPause.pausedAt);
          const taken = await legacyPause.take();
          if (taken === false && dispatchPower.pausedAt === legacyPause.pausedAt) dispatchPower.setPaused(false);
        } catch {
          console.warn($t("app.text_b8a0c84a1b"));
        }
        handoff.reportPower(dispatchPower.pausedAt);
      }
      moduleTasksActive = true;
      for (const start of pendingModuleTasks) start();
      pendingModuleTasks.clear();
      milkyTransport?.start();
      checkinRuntime?.start();
      dailyNoteReminders?.start();
      shopPlans?.start(lifecycle.signal, () => console.warn($t("app.text_3ffac62e40")));
      plugins.startWatching();
      stopPowerSchedule = scheduleDispatchPower(botConfig, async (paused) => {
        if (stopping) return;
        let reply: string | undefined;
        try {
          reply = dispatchPower.setPaused(paused);
        } catch {
          console.warn($t("app.text_e3fe4f8a47"));
          return;
        }
        if (reply === undefined) return;
        console.log($t("app.text_d0374637fe", { "reply": reply }));
        const notifications = await Promise.all(processOwnerTargets().map((target) => sendProcessMessage(target, reply)));
        if (notifications.includes(false)) {
          console.warn($t("app.text_c8ada095e7"));
        }
      });
      if (handoff.managed || canRestartHost()) {
        stopRestartSchedule = scheduleProcessRestart(botConfig, () => {
          const targets: ProcessReceipt["target"][] = processOwnerTargets(permissions.botIds());
          if (permissions.terminal) targets.push({ type: "terminal" });
          return startProcessAction("restart", targets);
        });
      } else if (botConfig.restart_time || botConfig.restart_cron) {
        console.warn($t("app.text_0765a5d981"));
      }
      try { updateNotices.initialize(readUpdateNoticeSettings(botConfig)); }
      catch { console.warn($t("app.text_d17d691ff0")); }
      if (handoff.managed) stopUpdateSchedule = scheduleUpdates(botConfig, requestScheduledUpdate);
      else if (botConfig.update_time || botConfig.update_cron) {
        console.warn($t("app.text_f6d5379d36"));
      }
      console.info(formatTerminalLog("mark", $t("app.text_6502f15dc6")));
      queueStartupMessages();

      const terminalReply = createTerminalReply(fileToUrl, terminalOutput);
      consoleInput = createTerminalInput(() => {
        const report = !stopping && handoff.managed;
        interrupt();
        if (report) console.info(formatTerminalLog("mark", $t("app.text_e5a73c676a")));
      });
      for await (const message of consoleInput) {
        if (stopping) break;
        const waiting = Promise.withResolvers<void>();
        const handling = dispatch({
          msg: message.trim(),
          raw_message: message,
          message,
          post_type: "message",
          message_type: "terminal",
          isGroup: false,
          isPrivate: false,
          isMaster: permissions.terminal,
          onAwaitInput: waiting.resolve,
          reply: terminalReply,
        }).catch(() => {
          console.error($t("app.text_9cc148daca"));
        });
        await Promise.race([handling, waiting.promise]);
        if (!stopping && process.stdin.isTTY) consoleInput.prompt(true);
      }
      if (servers.length || milkyTransport) await shutdown.promise;
    }
  } catch (error) {
    if (!stopping) throw error;
  } finally {
    stopping = true;
    await captchaService?.close();
    setDefaultCaptchaSolver(undefined);
    manualCaptcha?.close();
    publicFiles.close();
    lifecycle.abort();
    handoff.cancelUpdate();
    try {
      consoleInput?.close();
      legacy.stopContexts();
      if (legacyProcessReady && legacyBot) {
        legacyExitHooksRan = await legacy.exitHooks.run(legacyBot, exitReason);
      }
      await Promise.allSettled([...pending, stopPowerSchedule?.(), stopRestartSchedule?.(), stopUpdateSchedule?.(), updateNotices.stop(),
        moduleTasks.stop(), stopMilky?.(), checkinRuntime?.stop(), dailyNoteReminders?.stop()]);
      miyousheWeb?.close();
      panelOwnerSession?.close();
      await mediaDelivery.close();
      await plugins?.dispose();
    } finally {
      try {
        await Promise.all(servers.map((server) => server.stop(true)));
      } finally {
        try {
          await legacy.dispose();
        } finally {
          try {
            await Promise.allSettled(pendingCounts);
            globalThis.redis = undefined;
            try {
              await Promise.all([closeStorage(), stopStaticRenderer()]);
            } finally {
              await runtimeLog?.close();
            }
          } finally {
            process.off("SIGINT", interrupt);
            process.off("SIGTERM", terminate);
            handoff.reportPower(dispatchPower.pausedAt);
            stopOnDisconnect();
            stopForReplacement();
          }
        }
      }
    }
  }
  if (processAction && process.exitCode === 0) {
    const { kind, at, targets, pausedAt } = processAction;
    const saved = await Promise.allSettled(targets.map((target) => processReceipts.save({ kind, at, target })));
    if (saved.some((result) => result.status === "rejected")) {
      console.warn($t("app.text_95fea56fec"));
    }
    if (kind === "restart") {
      try {
        if (handoff.managed) {
          const sent = Promise.withResolvers<boolean>();
          if (!handoff.restart(pausedAt, (error) => sent.resolve(!error))) {
            throw new Error($t("app.text_4abf8b843e"));
          }
          const timer = setTimeout(() => sent.resolve(false), 1_000);
          try {
            if (!await sent.promise) throw new Error($t("app.text_5621a8beba"));
          } finally {
            clearTimeout(timer);
          }
        } else {
          restartHost(pausedAt);
        }
      } catch {
        await Promise.allSettled(targets.map((target, index) => {
          if (saved[index]?.status === "fulfilled") {
            return target.type === "terminal" ? processReceipts.discard() : processReceipts.discard(target.botId, target.adapter);
          }
        }));
        console.error($t("app.text_93d5acaef0"));
        process.exitCode = 1;
      }
    }
  }
  // 插件可能留下未登记的活动句柄。完成清理及重启交接后，正常退出
  // 不会被这条定时器延迟，仍被句柄占用的进程才需要它结束。
  if (shutdownRequested || legacyExitHooksRan) {
    setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
  }
}
