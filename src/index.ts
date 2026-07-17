import { registerCommand } from "@vendetta/commands";
import { logger } from "@vendetta";
import { findAll, findByName, findByProps, findByStoreName, findByTypeNameAll } from "@vendetta/metro";
import { clipboard, FluxDispatcher } from "@vendetta/metro/common";
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
const ChannelMemberStore = findByStoreName("ChannelMemberStore");
const ThreadMemberListStore = findByStoreName("ThreadMemberListStore");
const UserGuildSettingsStore = findByStoreName("UserGuildSettingsStore");
const NotificationSettingsActions = findByProps("updateChannelOverrideSettings");
const hiddenDmChannels = new Map<string, any>();
const hiddenVoiceStates = new Map<string, any>();
const hiddenVoiceChannels = new Map<string, any>();
const hiddenMessages = new Map<string, Map<string, any>>();
const messageCollectionProxies = new WeakMap<object, any>();

let unpatches: Array<() => void> = [];
let unregisterCommands: Array<() => void> = [];
let memberPatchTimer: ReturnType<typeof setInterval> | undefined;
let patchedMemberModules = new WeakSet<object>();
let patchedMemberComponentCount = 0;
let memberRowRenderCount = 0;
let lastMemberRowProps: any;
let patchedVoiceModules = new WeakSet<object>();
let patchedVoiceComponentCount = 0;
let voiceRowRenderCount = 0;
let lastVoiceRowProps: any;
let originalGetVoiceStateForUser: ((userId: string) => any) | undefined;
let originalGetVoiceStatesForChannel: ((channelId: string) => any) | undefined;
let pluginActive = false;

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

function stripBlockedMentions(message: any) {
    if (!message || typeof message !== "object") return message;

    let changed = false;
    let content = message.content;
    if (typeof content === "string") {
        const filtered = content.replace(/<@!?(\d{17,20})>/g, (mention: string, userId: string) => {
            if (!isBlocked(userId)) return mention;
            changed = true;
            return "";
        });
        if (filtered !== content) content = filtered;
    }

    let mentions = message.mentions;
    if (Array.isArray(mentions)) {
        const filtered = mentions.filter((user: any) => !isBlocked(user?.id));
        if (filtered.length !== mentions.length) {
            mentions = filtered;
            changed = true;
        }
    }

    return changed ? { ...message, content, mentions } : message;
}

function sanitizeMessage(message: any) {
    return stripBlockedMentions(stripBlockedReply(message));
}

function messageArray(value: any): any[] | undefined {
    if (Array.isArray(value)) return value;
    if (Array.isArray(value?._array)) return value._array;
    if (Array.isArray(value?.toArray?.())) return value.toArray();
}

function visibleMessages(messages: any[]): any[] {
    return messages.filter(message => !isBlocked(message?.author?.id)).map(sanitizeMessage);
}

function filterMessageCollection(value: any): any {
    if (Array.isArray(value)) return visibleMessages(value);
    if (!value || typeof value !== "object") return value;

    const cached = messageCollectionProxies.get(value);
    if (cached) return cached;

    const proxy = new Proxy(value, {
        get(target, property) {
            const source = messageArray(target);
            if (!source) {
                const result = Reflect.get(target, property, target);
                return typeof result === "function" ? result.bind(target) : result;
            }

            const messages = visibleMessages(source);
            if (property === "_array") return messages;
            if (property === "length" || property === "size") return messages.length;
            if (property === "toArray") return () => messages;
            if (property === Symbol.iterator || property === "values") return messages.values.bind(messages);
            if (property === "map" || property === "filter" || property === "forEach" || property === "at") {
                return (messages as any)[property].bind(messages);
            }
            if (property === "first") return () => messages[0];
            if (property === "last") return () => messages[messages.length - 1];

            const result = Reflect.get(target, property, target);
            return typeof result === "function" ? result.bind(target) : result;
        }
    });
    messageCollectionProxies.set(value, proxy);
    return proxy;
}

function rememberHiddenMessage(message: any) {
    const userId = message?.author?.id;
    if (!userId || !message?.id) return;
    let messages = hiddenMessages.get(userId);
    if (!messages) hiddenMessages.set(userId, messages = new Map());
    messages.set(message.id, message);
}

function restoreHiddenMessages(userId: string) {
    const messages = hiddenMessages.get(userId);
    hiddenMessages.delete(userId);
    if (!messages) return;

    for (const message of [...messages.values()].sort((a, b) => {
        try { return BigInt(a.id) < BigInt(b.id) ? -1 : 1; }
        catch { return 0; }
    })) {
        FluxDispatcher.dispatch({
            type: "MESSAGE_CREATE",
            channelId: message.channel_id ?? message.channelId,
            message,
            optimistic: false,
            isPushNotification: false,
            isHistory: true,
            blacklistLocal: true
        });
    }
}

function removeMountedMessages(userId: string) {
    try {
        const channelId = SelectedChannelStore?.getChannelId?.();
        const messages = messageArray(MessageStore?.getMessages?.(channelId));
        if (!channelId || !messages) return;

        for (const message of messages) {
            if (message?.author?.id === userId) {
                rememberHiddenMessage(message);
                continue;
            }

            const sanitized = sanitizeMessage(message);
            if (sanitized !== message) {
                FluxDispatcher.dispatch({
                    type: "MESSAGE_UPDATE",
                    channelId,
                    message: sanitized,
                    blacklistLocal: true
                });
            }
        }
        MessageStore?.emitChange?.();
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

function recipientIds(channel: any): string[] {
    return [
        ...(Array.isArray(channel?.recipients) ? channel.recipients : []),
        ...(Array.isArray(channel?.rawRecipients) ? channel.rawRecipients : []),
        channel?.getRecipientId?.()
    ].map(recipient => typeof recipient === "string" ? recipient : recipient?.id).filter(Boolean);
}

function memberRowUserId(props: any, depth = 0, seen = new Set<any>()): string | undefined {
    if (!props || typeof props !== "object" || depth > 5 || seen.has(props)) return;
    seen.add(props);

    const direct = getUserId(props.userId)
        ?? getUserId(props.user_id)
        ?? getUserId(props.user?.id)
        ?? getUserId(props.member?.userId)
        ?? getUserId(props.member?.user_id)
        ?? getUserId(props.member?.id)
        ?? getUserId(props.member?.user?.id)
        ?? getUserId(props.item?.userId)
        ?? getUserId(props.item?.user_id)
        ?? getUserId(props.item?.user?.id)
        ?? getUserId(props.row?.userId)
        ?? getUserId(props.row?.user_id)
        ?? getUserId(props.row?.user?.id)
        ?? getUserId(props.data?.userId)
        ?? getUserId(props.data?.user_id)
        ?? getUserId(props.data?.user?.id)
        ?? getUserId(props.guildMember?.userId)
        ?? getUserId(props.guildMember?.user_id)
        ?? getUserId(props.guildMember?.user?.id);
    if (direct) return direct;

    for (const [key, value] of Object.entries(props)) {
        if (!/user|member|item|row|data|record|entry|payload/i.test(key)) continue;
        if (typeof value === "string") {
            const id = getUserId(value);
            if (id) return id;
        }
        const nested = memberRowUserId(value, depth + 1, seen);
        if (nested) return nested;
    }
}

function patchMemberComponent(target: any, method: string): boolean {
    if (!target || typeof target !== "object" || patchedMemberModules.has(target) || typeof target[method] !== "function") return false;
    patchedMemberModules.add(target);
    unpatches.push(after(method, target, ([props], result) => {
        memberRowRenderCount++;
        lastMemberRowProps = props;
        const userId = memberRowUserId(props);
        return userId && isBlocked(userId) ? null : result;
    }));
    patchedMemberComponentCount++;
    return true;
}

function patchMembersTab() {
    try {
        const raw = findByName("GuildChannelMemberRow", false);
        if (raw && typeof raw === "object") {
            for (const key of Object.keys(raw)) {
                if (raw[key]?.name === "GuildChannelMemberRow" || key === "default") {
                    patchMemberComponent(raw, key);
                }
            }
        }
    } catch { }

    try {
        for (const wrapper of findByTypeNameAll("GuildChannelMemberRow")) {
            if (wrapper?.type?.name === "GuildChannelMemberRow") patchMemberComponent(wrapper, "type");
        }
    } catch { }
}

function privateChannels(): any[] {
    const channels = new Map<string, any>();
    for (const method of ["getSortedPrivateChannels", "getPrivateChannels", "getMutablePrivateChannels"]) {
        try {
            const result = ChannelStore?.[method]?.();
            const values = Array.isArray(result)
                ? result
                : result instanceof Map
                    ? [...result.values()]
                    : result && typeof result === "object"
                        ? Object.values(result)
                        : [];
            for (const value of values) {
                const channel = typeof value === "string" ? ChannelStore?.getChannel?.(value) : value;
                if (channel?.id) channels.set(channel.id, channel);
            }
        } catch { }
    }
    return [...channels.values()];
}

function findDirectMessages(userId: string): any[] {
    const result = privateChannels().filter(channel => {
        return (channel?.type === 1 || channel?.isDM?.()) && recipientIds(channel).includes(userId);
    });

    try {
        const dm = ChannelStore?.getDMFromUserId?.(userId);
        const channel = typeof dm === "string" ? ChannelStore?.getChannel?.(dm) : dm;
        if (channel?.id && !result.some(value => value.id === channel.id)) result.push(channel);
    } catch { }
    return result;
}

function savedDmNotificationSettings(): AnyRecord {
    storage.dmNotificationSettings ??= {};
    return storage.dmNotificationSettings;
}

function channelNotificationOverride(channelId: string): any {
    try {
        return UserGuildSettingsStore?.getChannelOverrides?.(null)?.[channelId]
            ?? UserGuildSettingsStore?.getChannelOverrides?.("@me")?.[channelId]
            ?? null;
    } catch {
        return null;
    }
}

function muteDmNotifications(userId: string, channels = findDirectMessages(userId)) {
    if (!NotificationSettingsActions?.updateChannelOverrideSettings) return;

    const saved = savedDmNotificationSettings();
    for (const channel of channels) {
        if (!channel?.id) continue;
        if (!(channel.id in saved)) {
            const override = channelNotificationOverride(channel.id);
            saved[channel.id] = {
                userId,
                override: override ? {
                    muted: !!override.muted,
                    mute_config: override.mute_config ?? null,
                    message_notifications: override.message_notifications ?? 3
                } : null
            };
        }

        try {
            const result = NotificationSettingsActions.updateChannelOverrideSettings(null, channel.id, {
                muted: true,
                mute_config: { end_time: null, selected_time_window: -1 },
                message_notifications: 2
            });
            Promise.resolve(result).catch(error => logger.warn("Failed to mute blocked DM notifications", error));
        } catch (error) {
            logger.warn("Failed to mute blocked DM notifications", error);
        }
    }
}

function restoreDmNotifications(userId: string) {
    if (!NotificationSettingsActions?.updateChannelOverrideSettings) return;

    const saved = savedDmNotificationSettings();
    for (const [channelId, state] of Object.entries(saved)) {
        if ((state as any)?.userId !== userId) continue;
        const override = (state as any)?.override ?? {
            muted: false,
            mute_config: null,
            message_notifications: 3
        };

        try {
            const result = NotificationSettingsActions.updateChannelOverrideSettings(null, channelId, override);
            Promise.resolve(result).catch(error => logger.warn("Failed to restore DM notifications", error));
        } catch (error) {
            logger.warn("Failed to restore DM notifications", error);
        }
        delete saved[channelId];
    }
}

function hideDirectMessages(userId: string, knownChannels = findDirectMessages(userId)) {
    muteDmNotifications(userId, knownChannels);
    for (const channel of knownChannels) {
        hiddenDmChannels.set(userId, channel);
    }
    refreshLists();
}

function restoreDirectMessage(userId: string) {
    hiddenDmChannels.delete(userId);
    refreshLists();
}

function isBlockedDirectMessage(value: any): boolean {
    const channel = typeof value === "string" ? ChannelStore?.getChannel?.(value) : value;
    return !!channel
        && (channel.type === 1 || channel.isDM?.())
        && recipientIds(channel).some(isBlocked);
}

function filterPrivateChannels(value: any): any {
    if (Array.isArray(value)) return value.filter(item => !isBlockedDirectMessage(item));
    if (value instanceof Map) {
        return new Map([...value.entries()].filter(([key, item]) => {
            return !isBlockedDirectMessage(item) && !isBlockedDirectMessage(key);
        }));
    }
    if (!value || typeof value !== "object") return value;

    let changed = false;
    const result: AnyRecord = { ...value };
    for (const [key, item] of Object.entries(result)) {
        if (isBlockedDirectMessage(item) || isBlockedDirectMessage(key)) {
            delete result[key];
            changed = true;
        } else if (Array.isArray(item)) {
            const filtered = item.filter(entry => !isBlockedDirectMessage(entry));
            if (filtered.length !== item.length) {
                result[key] = filtered;
                changed = true;
            }
        }
    }
    return changed ? result : value;
}

function currentVoiceState(userId: string): any {
    try { return originalGetVoiceStateForUser?.(userId); }
    catch { return undefined; }
}

function voiceStateValues(value: any): any[] {
    if (!value || typeof value !== "object") return [];
    if (Array.isArray(value)) return value;
    if (value instanceof Map) return [...value.values()];
    return Object.values(value);
}

function restoreVoiceChannel(channelId: string | undefined) {
    if (!channelId) return;
    const channel = hiddenVoiceChannels.get(channelId);
    hiddenVoiceChannels.delete(channelId);
    if (channel) FluxDispatcher.dispatch({ type: "CHANNEL_CREATE", channel });
}

function hideEmptyVoiceChannel(channelId: string | undefined) {
    if (!channelId || hiddenVoiceChannels.has(channelId)) return;
    let states: any[] = [];
    try { states = voiceStateValues(originalGetVoiceStatesForChannel?.(channelId)); } catch { }
    if (states.some(state => !isBlocked(voiceUserId(state)))) return;

    const channel = ChannelStore?.getChannel?.(channelId);
    if (!channel) return;
    hiddenVoiceChannels.set(channelId, channel);
    FluxDispatcher.dispatch({ type: "CHANNEL_DELETE", channel });
}

function hideVoicePresence(userId: string, state = currentVoiceState(userId)) {
    if (!state || !(state.channelId ?? state.channel_id)) return;
    hiddenVoiceStates.set(userId, { ...state });
    FluxDispatcher.dispatch({
        type: "VOICE_STATE_UPDATES",
        voiceStates: [{ ...state, channelId: null, channel_id: null }]
    });
    hideEmptyVoiceChannel(state.channelId ?? state.channel_id);
}

function restoreVoicePresence(userId: string) {
    const state = hiddenVoiceStates.get(userId);
    hiddenVoiceStates.delete(userId);
    if (state) {
        restoreVoiceChannel(state.channelId ?? state.channel_id);
        FluxDispatcher.dispatch({ type: "VOICE_STATE_UPDATES", voiceStates: [state] });
    }
}

function refreshLists() {
    PrivateChannelSortStore?.emitChange?.();
    ChannelStore?.emitChange?.();
    try { ChannelMemberStore?.doEmitChanges?.(); } catch { }
    VoiceStateStore?.emitChange?.();
    try { VoiceStateStore?.doEmitChanges?.(); } catch { }
}

function voiceUserId(value: any): string | undefined {
    return getUserId(value?.userId)
        ?? getUserId(value?.user_id)
        ?? getUserId(value?.user?.id)
        ?? getUserId(value?.member?.userId)
        ?? getUserId(value?.member?.user?.id)
        ?? getUserId(value?.voiceState?.userId)
        ?? getUserId(value?.voiceState?.user_id)
        ?? getUserId(value?.voiceState?.user?.id)
        ?? getUserId(value?.participant?.userId)
        ?? getUserId(value?.participant?.user?.id);
}

function filterVoiceCollection(result: any): any {
    if (!result || typeof result !== "object") return result;
    if (isBlocked(voiceUserId(result))) return undefined;

    if (Array.isArray(result)) {
        return result
            .filter(value => !isBlocked(voiceUserId(value)))
            .map(filterVoiceCollection);
    }

    if (result instanceof Map) {
        return new Map([...result.entries()]
            .filter(([key, value]) => !isBlocked(key) && !isBlocked(voiceUserId(value)))
            .map(([key, value]) => [key, filterVoiceCollection(value)]));
    }

    const prototype = Object.getPrototypeOf(result);
    if (prototype !== Object.prototype && prototype !== null) return result;

    return Object.fromEntries(Object.entries(result)
        .filter(([key, value]) => !isBlocked(key) && !isBlocked(voiceUserId(value)))
        .map(([key, value]) => [key, filterVoiceCollection(value)]));
}

function pruneVoiceTree(node: any, depth = 0, seen = new Set<any>()): any {
    if (node == null || depth > 20) return node;
    if (Array.isArray(node)) {
        return node.map(value => pruneVoiceTree(value, depth + 1, seen)).filter(value => value != null);
    }
    if (typeof node !== "object" || seen.has(node)) return node;
    seen.add(node);

    const props = node.props;
    if (!props || typeof props !== "object") return node;
    if (isBlocked(voiceUserId(props))) return null;

    let changed = false;
    const nextProps: AnyRecord = { ...props };
    if ("children" in props) {
        const children = pruneVoiceTree(props.children, depth + 1, seen);
        if (children !== props.children) {
            nextProps.children = children;
            changed = true;
        }
    }

    for (const key of ["data", "voiceStates", "users", "members", "participants"]) {
        if (!(key in props)) continue;
        const filtered = filterVoiceCollection(props[key]);
        if (filtered !== props[key]) {
            nextProps[key] = filtered;
            changed = true;
        }
    }
    return changed ? { ...node, props: nextProps } : node;
}

function patchVoiceComponent(target: any, method: string): boolean {
    if (!target || typeof target !== "object" || patchedVoiceModules.has(target) || typeof target[method] !== "function") return false;
    patchedVoiceModules.add(target);
    unpatches.push(after(method, target, ([props], result) => {
        voiceRowRenderCount++;
        lastVoiceRowProps = props;
        return pruneVoiceTree(result);
    }));
    patchedVoiceComponentCount++;
    return true;
}

function patchVoiceRows() {
    try {
        const raw = findByName("GuildVoiceChannelRow", false);
        if (raw && typeof raw === "object") {
            for (const key of Object.keys(raw)) {
                if (raw[key]?.name === "GuildVoiceChannelRow" || key === "default") patchVoiceComponent(raw, key);
            }
        }
    } catch { }

    try {
        for (const wrapper of findByTypeNameAll("GuildVoiceChannelRow")) {
            if (wrapper?.type?.name === "GuildVoiceChannelRow") patchVoiceComponent(wrapper, "type");
        }
    } catch { }
}

function filterChannelMemberProps(result: any) {
    if (!result || !Array.isArray(result.rows) || !Array.isArray(result.groups)) return result;

    const counts = new Map<string, number>();
    let currentGroupId: string | undefined;
    const visibleRows = result.rows.filter((row: any) => {
        if (row?.type === "GROUP") {
            currentGroupId = row.id;
            counts.set(currentGroupId!, 0);
            return true;
        }

        if (row?.type === "MEMBER" && isBlocked(row.userId ?? row.user?.id)) return false;
        if (currentGroupId) counts.set(currentGroupId, (counts.get(currentGroupId) ?? 0) + 1);
        return true;
    });

    const rows = visibleRows.filter((row: any) => row?.type !== "GROUP" || (counts.get(row.id) ?? 0) > 0);
    const groups = result.groups
        .map((group: any) => ({
            ...group,
            count: counts.get(group.id) ?? group.count,
            index: rows.findIndex((row: any) => row?.type === "GROUP" && row.id === group.id)
        }))
        .filter((group: any) => group.count > 0 && group.index >= 0);

    return { ...result, groups, rows };
}

function patchDispatcher() {
    unpatches.push(before("dispatch", FluxDispatcher, ([event]) => {
        if (!event || typeof event !== "object") return;

        if (event.type === "LOAD_MESSAGES_SUCCESS" && Array.isArray(event.messages)) {
            event.messages.filter(message => isBlocked(message?.author?.id)).forEach(rememberHiddenMessage);
            event.messages = event.messages
                .filter(message => !isBlocked(message?.author?.id))
                .map(sanitizeMessage);
            return;
        }

        if ((event.type === "MESSAGE_CREATE" || event.type === "MESSAGE_UPDATE") && isBlocked(event.message?.author?.id)) {
            rememberHiddenMessage(event.message);
            event.type = "BLACKLIST_IGNORED_MESSAGE";
            event.message = null;
            return;
        }

        if ((event.type === "MESSAGE_CREATE" || event.type === "MESSAGE_UPDATE") && event.message) {
            event.message = sanitizeMessage(event.message);
            return;
        }

        if ((event.type === "TYPING_START" || event.type === "TYPING_START_LOCAL") && isBlocked(event.userId ?? event.user_id)) {
            event.type = "BLACKLIST_IGNORED_TYPING";
            return;
        }

        const createdDmIsBlocked = event.channel
            && (event.channel.type === 1 || event.channel.isDM?.())
            && recipientIds(event.channel).some(isBlocked);
        if (event.type === "CHANNEL_CREATE" && createdDmIsBlocked) {
            const userId = recipientIds(event.channel).find(isBlocked);
            if (userId) hiddenDmChannels.set(userId, event.channel);
            setTimeout(refreshLists, 0);
        }

        if (event.type === "VOICE_STATE_UPDATES" && Array.isArray(event.voiceStates)) {
            const channelsToCheck = new Set<string>();
            event.voiceStates = event.voiceStates.map((state: any) => {
                const userId = state?.userId ?? state?.user_id;
                const channelId = state?.channelId ?? state?.channel_id;
                if (!isBlocked(userId)) {
                    if (channelId && hiddenVoiceChannels.has(channelId)) setTimeout(() => restoreVoiceChannel(channelId), 0);
                    return state;
                }

                if (channelId) {
                    hiddenVoiceStates.set(userId, { ...state });
                    channelsToCheck.add(channelId);
                }
                muteVoice(userId);
                return { ...state, channelId: null, channel_id: null };
            });
            if (channelsToCheck.size) setTimeout(() => channelsToCheck.forEach(hideEmptyVoiceChannel), 0);
        }

        if (event.type === "CONNECTION_OPEN" || event.type === "CACHE_LOADED") {
            setTimeout(() => pluginActive && blockedIds().forEach(userId => hideDirectMessages(userId)), 0);
            setTimeout(() => pluginActive && blockedIds().forEach(userId => hideDirectMessages(userId)), 1500);
        }
    }));
}

function patchStores() {
    if (MessageStore?.getMessages) {
        unpatches.push(after("getMessages", MessageStore, (_args, result) => filterMessageCollection(result)));
    }

    for (const store of [PrivateChannelSortStore, ChannelStore]) {
        const privateChannelMethods = new Set<string>();
        let prototype = store;
        for (let depth = 0; prototype && depth < 4; depth++, prototype = Object.getPrototypeOf(prototype)) {
            for (const key of Reflect.ownKeys(prototype)) {
                if (typeof key === "string" && /(private|direct).*channel|channel.*(private|direct)/i.test(key)
                    && typeof store?.[key] === "function") privateChannelMethods.add(key);
            }
        }
        for (const method of privateChannelMethods) {
            unpatches.push(after(method, store, (_args, result) => filterPrivateChannels(result)));
        }
    }

    if (TypingStore?.getTypingUsers) {
        unpatches.push(after("getTypingUsers", TypingStore, (_args, result) => {
            if (!result || typeof result !== "object") return result;
            return Object.fromEntries(Object.entries(result).filter(([userId]) => !isBlocked(userId)));
        }));
    }

    for (const method of [
        "getVoiceStatesForChannel",
        "getVoiceStates",
        "getVoiceStatesForGuild",
        "getVoiceStateForChannel",
        "getAllVoiceStates",
        "getVideoVoiceStatesForChannel",
        "getVoiceState",
        "getDiscoverableVoiceState",
        "getVoiceStateForSession"
    ]) {
        if (typeof VoiceStateStore?.[method] !== "function") continue;
        unpatches.push(after(method, VoiceStateStore, (_args, result) => filterVoiceCollection(result)));
    }

    for (const method of ["getVoiceStateForUser", "getDiscoverableVoiceStateForUser", "getUserVoiceChannelId"]) {
        if (typeof VoiceStateStore?.[method] !== "function") continue;
        unpatches.push(after(method, VoiceStateStore, (args, result) => {
            const requestedBlockedUser = args.some((arg: any) => typeof arg === "string" && isBlocked(arg));
            return requestedBlockedUser || isBlocked(voiceUserId(result)) ? undefined : result;
        }));
    }

    if (ChannelMemberStore?.getProps) {
        unpatches.push(after("getProps", ChannelMemberStore, (_args, result) => filterChannelMemberProps(result)));
    }

}

function registerCommands() {
    const userOption = [{
        name: "user",
        description: "Выберите пользователя или вставьте его Discord ID",
        type: 6,
        required: false
    }];
    const unblockUserOption: any = {
        name: "user",
        description: "Выберите пользователя из чёрного списка",
        type: 3,
        required: true,
        choices: []
    };
    const refreshUnblockChoices = () => {
        unblockUserOption.choices = blockedIds().map(userId => {
            const user = UserStore?.getUser?.(userId);
            const name = user?.globalName ?? user?.username ?? userId;
            return { name, displayName: name, label: name, value: userId };
        });
    };
    refreshUnblockChoices();

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

            const dmChannels = findDirectMessages(userId);
            const voiceState = currentVoiceState(userId);
            storage.users = [...blockedIds(), userId];
            refreshUnblockChoices();
            muteVoice(userId);
            hideVoicePresence(userId, voiceState);
            removeMountedMessages(userId);
            hideDirectMessages(userId, dmChannels);
            refreshLists();
            FluxDispatcher.dispatch({ type: "BLACKLIST_REFRESH" });
            success(`${nameFor(userId)} добавлен в список`);
        }
    } as any));

    unregisterCommands.push(registerCommand({
        name: "unblock",
        description: "Перестать скрывать пользователя",
        options: [unblockUserOption],
        execute: args => {
            const userId = commandUserId(args);
            if (!userId) return failure("Выберите пользователя или вставьте его ID");
            if (!isBlocked(userId)) return failure(`${nameFor(userId)} отсутствует в списке`);

            storage.users = blockedIds().filter(id => id !== userId);
            refreshUnblockChoices();
            restoreHiddenMessages(userId);
            restoreVoice(userId);
            restoreVoicePresence(userId);
            restoreDmNotifications(userId);
            restoreDirectMessage(userId);
            refreshLists();
            void refreshMessages();
        }
    } as any));

    unregisterCommands.push(registerCommand({
        name: "blockdebug",
        description: "Copy Blacklist diagnostics for the current Discord screen",
        options: [],
        execute: (_args, ctx) => {
            const describe = (value: any, depth = 0): any => {
                if (value == null || typeof value !== "object") return value;
                if (depth > 2) return Array.isArray(value) ? `[Array:${value.length}]` : "[Object]";
                if (Array.isArray(value)) return value.slice(0, 3).map(item => describe(item, depth + 1));
                const output: AnyRecord = {};
                for (const key of Object.keys(value).slice(0, 30)) {
                    try { output[key] = describe(value[key], depth + 1); } catch { output[key] = "[Error]"; }
                }
                return output;
            };

            const moduleName = (value: any) => value?.name
                ?? value?.displayName
                ?? value?.type?.name
                ?? value?.type?.displayName;

            const componentNames = findAll(value => {
                const name = moduleName(value);
                return typeof name === "string" && /member|channel.*detail|detail.*channel/i.test(name);
            }).map(moduleName).filter(Boolean);

            const dmComponentNames = findAll(value => {
                const name = moduleName(value);
                return typeof name === "string" && /private.*channel|direct.*message|dm.*row|channel.*row|channel.*item/i.test(name);
            }).map(moduleName).filter(Boolean);

            const memberStores = findAll(value => {
                try { return typeof value?.getName === "function" && /member/i.test(value.getName()); }
                catch { return false; }
            }).map(store => ({
                name: store.getName(),
                methods: Object.keys(store).filter(key => typeof store[key] === "function").slice(0, 50)
            }));

            let channelMemberProps: any;
            let threadSections: any;
            let voiceStates: any;
            try { channelMemberProps = ChannelMemberStore?.getProps?.(ctx?.guild?.id, ctx?.channel?.id); } catch (error) { channelMemberProps = String(error); }
            try { threadSections = ThreadMemberListStore?.getMemberListSections?.(ctx?.channel?.id); } catch (error) { threadSections = String(error); }
            try {
                const voiceChannelId = SelectedChannelStore?.getVoiceChannelId?.();
                voiceStates = {
                    voiceChannelId,
                    forChannel: describe(VoiceStateStore?.getVoiceStatesForChannel?.(voiceChannelId)),
                    forGuild: describe(VoiceStateStore?.getVoiceStates?.(ctx?.guild?.id ?? ctx?.channel?.guild_id))
                };
            } catch (error) { voiceStates = String(error); }

            const report = JSON.stringify({
                blockedIds: blockedIds(),
                guildId: ctx?.guild?.id,
                channelId: ctx?.channel?.id,
                componentNames: [...new Set(componentNames)],
                dmComponentNames: [...new Set(dmComponentNames)],
                membersPatch: {
                    patchedComponents: patchedMemberComponentCount,
                    renderCalls: memberRowRenderCount,
                    lastProps: describe(lastMemberRowProps)
                },
                voicePatch: {
                    patchedComponents: patchedVoiceComponentCount,
                    renderCalls: voiceRowRenderCount,
                    lastProps: describe(lastVoiceRowProps)
                },
                memberStores,
                channelMemberProps: describe(channelMemberProps),
                threadSections: describe(threadSections),
                voiceStates,
                voiceStoreMethods: (() => {
                    const names = new Set<string>();
                    let current = VoiceStateStore;
                    for (let depth = 0; current && depth < 4; depth++, current = Object.getPrototypeOf(current)) {
                        Reflect.ownKeys(current).forEach(key => typeof key === "string" && /voice|state/i.test(key) && names.add(key));
                    }
                    return [...names];
                })(),
                channelStoreMethods: Object.keys(ChannelStore ?? {}).filter(key => /private|dm/i.test(key)),
                privateSortMethods: Object.keys(PrivateChannelSortStore ?? {}).filter(key => typeof PrivateChannelSortStore[key] === "function")
            }, null, 2);

            clipboard.setString(report);
            success("Диагностика Block скопирована в буфер");
        }
    } as any));
}

export default {
    onLoad() {
        pluginActive = true;
        storage.users ??= [];
        storage.voiceVolumes ??= {};
        storage.soundboardMutes ??= {};
        storage.dmNotificationSettings ??= {};
        originalGetVoiceStateForUser = VoiceStateStore?.getVoiceStateForUser?.bind(VoiceStateStore);
        originalGetVoiceStatesForChannel = VoiceStateStore?.getVoiceStatesForChannel?.bind(VoiceStateStore);

        patchDispatcher();
        patchStores();
        patchMembersTab();
        patchVoiceRows();
        memberPatchTimer = setInterval(() => {
            patchMembersTab();
            patchVoiceRows();
            blockedIds().forEach(userId => hideDirectMessages(userId));
        }, 1000);
        registerCommands();
        blockedIds().forEach(removeMountedMessages);
        blockedIds().forEach(muteVoice);
        blockedIds().forEach(userId => hideVoicePresence(userId));
        blockedIds().forEach(userId => hideDirectMessages(userId));
        logger.log("Blacklist loaded");
    },

    onUnload() {
        pluginActive = false;
        unregisterCommands.splice(0).forEach(unregister => unregister());
        if (memberPatchTimer) clearInterval(memberPatchTimer);
        memberPatchTimer = undefined;
        unpatches.splice(0).reverse().forEach(unpatch => unpatch());
        blockedIds().forEach(restoreHiddenMessages);
        hiddenMessages.clear();
        patchedMemberModules = new WeakSet<object>();
        patchedVoiceModules = new WeakSet<object>();
        patchedMemberComponentCount = 0;
        memberRowRenderCount = 0;
        lastMemberRowProps = undefined;
        patchedVoiceComponentCount = 0;
        voiceRowRenderCount = 0;
        lastVoiceRowProps = undefined;
        blockedIds().forEach(restoreDmNotifications);
        blockedIds().forEach(restoreDirectMessage);
        blockedIds().forEach(restoreVoicePresence);
        [...hiddenVoiceChannels.keys()].forEach(restoreVoiceChannel);
        originalGetVoiceStateForUser = undefined;
        originalGetVoiceStatesForChannel = undefined;
        blockedIds().forEach(restoreVoice);
        logger.log("Blacklist unloaded");
    }
};
