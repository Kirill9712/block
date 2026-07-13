import { registerCommand } from "@vendetta/commands";
import { logger } from "@vendetta";
import { findByProps, findByStoreName, findByTypeNameAll } from "@vendetta/metro";
import { FluxDispatcher } from "@vendetta/metro/common";
import { before, after } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";

type AnyRecord = Record<string, any>;

const UserStore = findByProps("getCurrentUser", "getUser");
const MessageStore = findByProps("getMessages");
const SelectedChannelStore = findByProps("getChannelId", "getVoiceChannelId");
const TypingStore = findByProps("getTypingUsers");
const VoiceStateStore = findByProps("getVoiceStatesForChannel");
const MediaEngineStore = findByProps("getLocalVolume");
const MediaEngineActions = findByProps("setLocalVolume");
const SoundboardStore = findByProps("isLocalSoundboardMuted");
const MessageActions = findByProps("fetchMessages");
const ChannelStore = findByStoreName("ChannelStore");
const PrivateChannelSortStore = findByStoreName("PrivateChannelSortStore");
const GuildMemberStore = findByStoreName("GuildMemberStore");
const ChannelMemberStore = findByStoreName("ChannelMemberStore");
const ThreadMemberListStore = findByStoreName("ThreadMemberListStore");

let unpatches: Array<() => void> = [];
let unregisterCommands: Array<() => void> = [];

function blockedIds(): string[] {
    storage.users ??= [];
    if (typeof storage.users === "string") storage.users = storage.users.match(/\d{17,20}/g) ?? [];
    return [...new Set((storage.users as unknown[]).map(String).filter(id => /^\d{17,20}$/.test(id)))];
}

function isBlocked(userId: unknown): boolean {
    return typeof userId === "string" && blockedIds().includes(userId);
}

function getUserId(value: any): string | undefined {
    if (typeof value === "string") return value.match(/\d{17,20}/)?.[0];
    if (!value || typeof value !== "object") return;
    return getUserId(value.value)
        ?? getUserId(value.id)
        ?? getUserId(value.user?.id)
        ?? getUserId(value.member?.user?.id);
}

function commandUserId(args: any[]): string | undefined {
    for (const arg of args ?? []) {
        const id = getUserId(arg);
        if (id) return id;
    }
}

function nameFor(userId: string): string {
    const user = UserStore?.getUser?.(userId);
    return user ? `${user.globalName ?? user.username} (${userId})` : userId;
}

function success(message: string) {
    showToast(message, getAssetIDByName("Check"));
}

function failure(message: string) {
    showToast(message, getAssetIDByName("Small"));
}

function savedVolumes(): AnyRecord {
    storage.voiceVolumes ??= {};
    return storage.voiceVolumes;
}

function savedSoundboardMutes(): AnyRecord {
    storage.soundboardMutes ??= {};
    return storage.soundboardMutes;
}

function muteVoice(userId: string) {
    try {
        const volumes = savedVolumes();
        if (!(userId in volumes)) volumes[userId] = MediaEngineStore?.getLocalVolume?.(userId) ?? 100;
        MediaEngineActions?.setLocalVolume?.(userId, 0);
    } catch (error) {
        logger.warn("Failed to mute blocked voice user", error);
    }

    try {
        if (!SoundboardStore?.isLocalSoundboardMuted || !FluxDispatcher?.dispatch) return;
        const states = savedSoundboardMutes();
        if (!(userId in states)) states[userId] = !!SoundboardStore.isLocalSoundboardMuted(userId);
        if (!SoundboardStore.isLocalSoundboardMuted(userId)) {
            FluxDispatcher.dispatch({ type: "AUDIO_TOGGLE_LOCAL_SOUNDBOARD_MUTE", userId });
        }
    } catch (error) {
        logger.warn("Failed to mute blocked Soundboard user", error);
    }
}

function restoreVoice(userId: string) {
    try {
        const volumes = savedVolumes();
        MediaEngineActions?.setLocalVolume?.(userId, volumes[userId] ?? 100);
        delete volumes[userId];
    } catch (error) {
        logger.warn("Failed to restore voice volume", error);
    }

    try {
        const states = savedSoundboardMutes();
        if (!states[userId] && SoundboardStore?.isLocalSoundboardMuted?.(userId)) {
            FluxDispatcher.dispatch({ type: "AUDIO_TOGGLE_LOCAL_SOUNDBOARD_MUTE", userId });
        }
        delete states[userId];
    } catch (error) {
        logger.warn("Failed to restore Soundboard state", error);
    }
}

function referencedAuthorId(message: any): string | undefined {
    return message?.referenced_message?.author?.id
        ?? message?.referencedMessage?.author?.id;
}

function stripBlockedReply(message: any) {
    if (!message || !isBlocked(referencedAuthorId(message))) return message;
    return {
        ...message,
        referenced_message: null,
        referencedMessage: null,
        message_reference: null,
        messageReference: null
    };
}

function messageArray(value: any): any[] | undefined {
    if (Array.isArray(value)) return value;
    if (Array.isArray(value?._array)) return value._array;
    if (Array.isArray(value?.toArray?.())) return value.toArray();
}

function removeMountedMessages(userId: string) {
    try {
        const channelId = SelectedChannelStore?.getChannelId?.();
        const messages = messageArray(MessageStore?.getMessages?.(channelId));
        if (!channelId || !messages) return;

        for (const message of messages) {
            if (message?.author?.id !== userId) continue;
            FluxDispatcher.dispatch({
                type: "MESSAGE_DELETE",
                channelId,
                id: message.id,
                message: message.id,
                blacklistLocal: true
            });
        }
    } catch (error) {
        logger.warn("Failed to remove already mounted messages", error);
    }
}

async function refreshMessages() {
    const channelId = SelectedChannelStore?.getChannelId?.();
    if (!channelId) return;

    try {
        await MessageActions?.fetchMessages?.({ channelId });
    } catch {
        try {
            await MessageActions?.fetchMessages?.(channelId);
        } catch (error) {
            logger.warn("Failed to refresh messages after unblock", error);
        }
    }
}

function directMemberId(item: any): string | undefined {
    return item?.member?.user?.id
        ?? item?.member?.userId
        ?? item?.user?.id
        ?? item?.userId
        ?? item?.voiceState?.userId;
}

function isHiddenDirectMessage(channelId: string): boolean {
    const channel = ChannelStore?.getChannel?.(channelId);
    if (!channel || !(channel.type === 1 || channel.isDM?.())) return false;

    const recipientIds = [
        ...(Array.isArray(channel.recipients) ? channel.recipients : []),
        ...(Array.isArray(channel.rawRecipients) ? channel.rawRecipients : [])
    ].map(recipient => typeof recipient === "string" ? recipient : recipient?.id);

    const recipientId = channel.getRecipientId?.();
    if (recipientId) recipientIds.push(recipientId);
    return recipientIds.some(isBlocked);
}

function filterPrivateChannels(result: any): any {
    if (!result || typeof result !== "object") return result;

    if (Array.isArray(result)) {
        return result.filter(value => {
            const channelId = typeof value === "string" ? value : value?.id;
            return !channelId || !isHiddenDirectMessage(channelId);
        });
    }

    if (result instanceof Map) {
        return new Map([...result.entries()].filter(([channelId, channel]) => {
            const id = channel?.id ?? channelId;
            return !isHiddenDirectMessage(id);
        }));
    }

    const prototype = Object.getPrototypeOf(result);
    if (prototype !== Object.prototype && prototype !== null) return result;

    return Object.fromEntries(Object.entries(result).filter(([channelId, channel]: [string, any]) => {
        const id = channel?.id ?? channelId;
        return !isHiddenDirectMessage(id);
    }));
}

function filterMemberCollection(result: any, depth = 0): any {
    if (!result || typeof result !== "object" || depth > 3) return result;

    if (Array.isArray(result)) {
        // Arrays can contain user IDs, member/row objects, or whole sections.
        return result
            .filter(value => {
                if (typeof value === "string" && /^\d{17,20}$/.test(value)) return !isBlocked(value);
                const userId = directMemberId(value);
                return !userId || !isBlocked(userId);
            })
            .map(value => filterMemberCollection(value, depth + 1));
    }

    if (result instanceof Map) {
        return new Map([...result.entries()]
            .filter(([key, value]) => !isBlocked(key) && !isBlocked(directMemberId(value)))
            .map(([key, value]) => [key, filterMemberCollection(value, depth + 1)]));
    }

    const prototype = Object.getPrototypeOf(result);
    if (prototype !== Object.prototype && prototype !== null) return result;

    const next: AnyRecord = { ...result };
    for (const key of ["userIds", "rows", "items", "members", "sections"]) {
        if (key in next) next[key] = filterMemberCollection(next[key], depth + 1);
    }
    return next;
}

function refreshLists() {
    PrivateChannelSortStore?.emitChange?.();
    ChannelStore?.emitChange?.();
    GuildMemberStore?.emitChange?.();
    ChannelMemberStore?.emitChange?.();
    ThreadMemberListStore?.emitChange?.();
    VoiceStateStore?.emitChange?.();
}

function patchDispatcher() {
    unpatches.push(before("dispatch", FluxDispatcher, ([event]) => {
        if (!event || typeof event !== "object") return;

        if (event.type === "LOAD_MESSAGES_SUCCESS" && Array.isArray(event.messages)) {
            event.messages = event.messages
                .filter(message => !isBlocked(message?.author?.id))
                .map(stripBlockedReply);
            return;
        }

        if ((event.type === "MESSAGE_CREATE" || event.type === "MESSAGE_UPDATE") && isBlocked(event.message?.author?.id)) {
            event.type = "BLACKLIST_IGNORED_MESSAGE";
            event.message = null;
            return;
        }

        if ((event.type === "MESSAGE_CREATE" || event.type === "MESSAGE_UPDATE") && event.message) {
            event.message = stripBlockedReply(event.message);
            return;
        }

        if ((event.type === "TYPING_START" || event.type === "TYPING_START_LOCAL") && isBlocked(event.userId ?? event.user_id)) {
            event.type = "BLACKLIST_IGNORED_TYPING";
            return;
        }

        if (event.type === "VOICE_STATE_UPDATES" && Array.isArray(event.voiceStates)) {
            // Keep the update flowing so Discord's audio engine remains stable;
            // the voice store getter below hides the row from the channel list.
            for (const state of event.voiceStates) {
                if (isBlocked(state?.userId ?? state?.user_id)) muteVoice(state.userId ?? state.user_id);
            }
        }
    }));
}

function patchStores() {
    if (TypingStore?.getTypingUsers) {
        unpatches.push(after("getTypingUsers", TypingStore, (_args, result) => {
            if (!result || typeof result !== "object") return result;
            return Object.fromEntries(Object.entries(result).filter(([userId]) => !isBlocked(userId)));
        }));
    }

    if (VoiceStateStore?.getVoiceStatesForChannel) {
        unpatches.push(after("getVoiceStatesForChannel", VoiceStateStore, (_args, result) => {
            if (!result || typeof result !== "object") return result;
            if (Array.isArray(result)) return result.filter(state => !isBlocked(state?.userId ?? state?.user_id));
            if (result instanceof Map) {
                return new Map([...result.entries()].filter(([userId, state]: [string, any]) => {
                    return !isBlocked(userId) && !isBlocked(state?.userId ?? state?.user_id);
                }));
            }

            const prototype = Object.getPrototypeOf(result);
            if (prototype !== Object.prototype && prototype !== null) return result;
            return Object.fromEntries(Object.entries(result).filter(([userId, state]: [string, any]) => {
                return !isBlocked(userId) && !isBlocked(state?.userId ?? state?.user_id);
            }));
        }));
    }

    for (const method of ["getPrivateChannelIds", "getPinnedChannelIds"]) {
        if (typeof PrivateChannelSortStore?.[method] !== "function") continue;
        unpatches.push(after(method, PrivateChannelSortStore, (_args, result) => filterPrivateChannels(result)));
    }

    for (const method of ["getSortedPrivateChannels", "getPrivateChannels", "getMutablePrivateChannels"]) {
        if (typeof ChannelStore?.[method] !== "function") continue;
        unpatches.push(after(method, ChannelStore, (_args, result) => filterPrivateChannels(result)));
    }

    if (typeof GuildMemberStore?.getMembers === "function") {
        unpatches.push(after("getMembers", GuildMemberStore, (_args, result) => filterMemberCollection(result)));
    }

    if (typeof ChannelMemberStore?.getProps === "function") {
        unpatches.push(after("getProps", ChannelMemberStore, (_args, result) => filterMemberCollection(result)));
    }

    if (typeof ThreadMemberListStore?.getMemberListSections === "function") {
        unpatches.push(after("getMemberListSections", ThreadMemberListStore, (_args, result) => filterMemberCollection(result)));
    }

    // UserRow is used by the mobile member and voice lists. Returning null for
    // one row is safer than modifying Discord's GUILD_MEMBER_LIST_UPDATE data.
    findByTypeNameAll("UserRow").forEach(UserRow => {
        if (!UserRow?.type) return;
        unpatches.push(after("type", UserRow, ([props], result) => {
            return isBlocked(directMemberId(props)) ? null : result;
        }));
    });
}

function registerCommands() {
    const userOption = [{
        name: "user",
        description: "Выберите пользователя или вставьте его Discord ID",
        type: 6,
        required: false
    }];

    unregisterCommands.push(registerCommand({
        name: "block",
        description: "Скрыть пользователя или показать список",
        options: userOption,
        execute: args => {
            const userId = commandUserId(args);
            if (!userId) {
                const users = blockedIds();
                showToast(users.length ? `Скрыто: ${users.map(nameFor).join(", ")}` : "Список пуст");
                return;
            }
            if (userId === UserStore?.getCurrentUser?.()?.id) return failure("Нельзя скрыть самого себя");
            if (isBlocked(userId)) return failure(`${nameFor(userId)} уже скрыт`);

            storage.users = [...blockedIds(), userId];
            muteVoice(userId);
            removeMountedMessages(userId);
            refreshLists();
            FluxDispatcher.dispatch({ type: "BLACKLIST_REFRESH" });
            success(`${nameFor(userId)} добавлен в список`);
        }
    } as any));

    unregisterCommands.push(registerCommand({
        name: "unblock",
        description: "Перестать скрывать пользователя",
        options: userOption,
        execute: args => {
            const userId = commandUserId(args);
            if (!userId) return failure("Выберите пользователя или вставьте его ID");
            if (!isBlocked(userId)) return failure(`${nameFor(userId)} отсутствует в списке`);

            storage.users = blockedIds().filter(id => id !== userId);
            restoreVoice(userId);
            refreshLists();
            void refreshMessages();
        }
    } as any));
}

export default {
    onLoad() {
        storage.users ??= [];
        storage.voiceVolumes ??= {};
        storage.soundboardMutes ??= {};

        patchDispatcher();
        patchStores();
        registerCommands();
        blockedIds().forEach(muteVoice);
        logger.log("Blacklist loaded");
    },

    onUnload() {
        unregisterCommands.splice(0).forEach(unregister => unregister());
        unpatches.splice(0).reverse().forEach(unpatch => unpatch());
        blockedIds().forEach(restoreVoice);
        logger.log("Blacklist unloaded");
    }
};
