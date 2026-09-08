
import makeWASocket, {
    AuthenticationState, Chat as WAChat, BaileysEventMap, ConnectionState, Contact, DisconnectReason, downloadMediaMessage,
    fetchLatestBaileysVersion, GroupMetadata, makeCacheableSignalKeyStore,
    MessageUpsertType,
    proto, useMultiFileAuthState, WAMessage, WAMessageUpdate,
    WASocket,
    GroupParticipant,
    ParticipantAction,
    decryptEventResponse
} from 'baileys'

import fs from 'fs'
import QRCode from 'qrcode';
import { Boom } from '@hapi/boom'

import { v4 as uuidv4 } from 'uuid';
import NodeCache from 'node-cache'
import P from 'pino'
import { Chat, Contact as StoredContact, Message, MessageType, Role, WhatsappStore } from './WhatsappStore';

const usePairingCode = false;
const msgRetryCounterCache = new NodeCache();

export interface WAClientConfig {
    localConnectionId:string;
    fileStorageRoot:string;
}

export interface WAClientDetails{
    userID:string,
    msisdn:string,
    name?: string,
}

export interface GroupMessage {
    groupId:string;
    replyTo?:string
}

export interface PendingAlbum {
    chatId: string;
    albumMessageId: string;
    expectedImages: number;
    expectedVideos: number;
    receivedImages: number;
    receivedVideos: number;
    createdAt: number;
    mediaIds: string[];
}

export const ALBUM_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour default

export interface GroupTextMessage extends GroupMessage {
    text:string;
}

export interface GroupImageMessage extends GroupMessage {
    image:Buffer;
}

export interface GoupMessageResult {
    messageId:string;
}

export interface WhatsappTextMessage extends WhatsappMessage {
    text:string;
}

export interface WhatsappImageMessage extends WhatsappMessage {
    image:Buffer;
}

export interface WhatsappMessage {
    timestamp:number;
    messageId:string;
    chat:{
        id:string,
        name:string
    },
    sender:{
        id:string,
        name:string,
        me:boolean
    },
    type:MessageType;
    payload:object;
}

export interface WhatsappSendMessageRequest {
    text?:any,
    image?:any,
    video?:any,
    document?:any,
    documentName?:string,
    documentMimetype?:string,
    replyTo?:any,
}

export interface WhatsappSendMessageResponse {
    messageId:string
}



export interface WhatsappSubscribeFilter {
    types?:MessageType[];
    groupId?:string;
}

export class WhatsappClient{
    private currentQRCode!:string;
    private onQRCodeListeners:any[] = [];
    private onConnectionSuccessListeners:any[] = [];

    private config:WAClientConfig;
    private socket!: WASocket;
    private store!: WhatsappStore;
    private state!:AuthenticationState
    private messageSubscribers:{[key:string]: (message: WhatsappMessage) => void } = {};
    private subscriberKeys: Map<Subscription, string> = new Map();
    private logger!: P.Logger<never, boolean>;
    private saveCreds!: () => Promise<void>;
    private groupClients:{[key:string]:GroupClient} = {};
    private pendingAlbums: Map<string, PendingAlbum> = new Map();
    private albumCleanupTimer?: NodeJS.Timeout;
    private reconnectTimer?: NodeJS.Timeout;

    // services.
    private _groupService! : GroupService;

    constructor(config:WAClientConfig){
        this.config = config;
    }

    public clientConfig():WAClientConfig{
        return this.config;
    }

    public details(): WAClientDetails | null {
        if (!this.state?.creds?.me) return null;
        const userID = this.state.creds.me.id.replace(/:\d+(?=@)/, "");
        return {
            userID,
            msisdn: userID.substring(0, userID.indexOf("@")),
            name: (this.state.creds.me as any).name ?? undefined,
        };
    }

    public onQRCode(listener: (qrcode: string) => void) {
        this.onQRCodeListeners.push(listener);
        // when someone subscribes to the qr code and there is a current active QR code, send it out.
        if(this.currentQRCode){
            listener(this.currentQRCode);
        }
    }

    public groups():GroupService {
        return this._groupService;
    }

    public getGroupClient(groupId: string): GroupClient {
        let groupClient = this.groupClients[groupId];
        if(!groupClient){
            this.groupClients[groupId] = groupClient = new GroupClient(this, groupId);
        }
        return groupClient;
    }

    public subscribe(listener:(message:WhatsappMessage) => void, filter?:WhatsappSubscribeFilter):string {
        let subscriberID:string = uuidv4();
        filter = filter ? filter : {};
        console.log("subscribe to whatsapp messages", filter);
        this.messageSubscribers[subscriberID] = (message:WhatsappMessage) => {
            console.log("Received message: ", message);
            if(
                (!filter.groupId || filter.groupId === message.chat.id) &&
                (!filter.types || filter.types.length === 0 || filter.types.indexOf(message.type) > -1)
            ){
                listener(message);
            }
        };
        this.subscriberKeys.set(listener, subscriberID);
        return subscriberID;
    }

    public unsubscribe(subscriber:Subscription){
        const id = this.subscriberKeys.get(subscriber);
        if(id) {
            delete this.messageSubscribers[id];
            this.subscriberKeys.delete(subscriber);
        }
    }

    private subscribers():((message: WhatsappMessage) => void)[]{
        return Object.values(this.messageSubscribers);
    }

    public async sendMessage(chatId: string, message: WhatsappSendMessageRequest):Promise<WhatsappSendMessageResponse> {
        let result;

        if(message.image) {
            result = await this.socket.sendMessage(chatId, {
                image: message.image,
                caption: message.text
            });
        } else if(message.video) {
            result = await this.socket.sendMessage(chatId, {
                video: message.video,
                caption: message.text
            });
        } else if(message.document) {
            result = await this.socket.sendMessage(chatId, {
                document: message.document,
                fileName: message.documentName ?? 'document',
                mimetype: message.documentMimetype ?? 'application/octet-stream',
                caption:  message.text
            });
        } else if(message.text) {
            result = await this.socket.sendMessage(chatId, { text: message.text });
        } else {
            throw new Error("Message must contain text, image, or video");
        }

        return { messageId: result!.key.id! };
    }

    public onConnectionSuccess(listener: () => void) {
        this.onConnectionSuccessListeners.push(listener);
    }

    public async start(){
        if(this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        console.log("starting client", this.clientConfig());
        
        this.logger = P({ timestamp: () => `,"time":"${new Date().toJSON()}"` }, P.destination(this.config.fileStorageRoot + '/wa-logs.txt'));
        this.logger.level = 'trace';

        // attempt to load the local config.
        const { state, saveCreds } = await useMultiFileAuthState(this.config.fileStorageRoot +"/" + this.config.localConnectionId);
        this.state = state;
        this.saveCreds = saveCreds;
        
        // fetch latest version of WA Web
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`);

        // before creating the connection, create / open the database.
        this.store = await WhatsappStore.createStore(this.config.localConnectionId, this.config.fileStorageRoot +"/" + this.config.localConnectionId);

        // create the websocket.
        this.socket = makeWASocket({
            version:version,
            logger:this.logger,
            //printQRInTerminal: !usePairingCode,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, this.logger),
            },
            msgRetryCounterCache,
            generateHighQualityLinkPreview: true,
            // uncomment to avoid receiving historic messages.
            //shouldSyncHistoryMessage:() => false,
            //getMessage
        });

        // create the services.
        this._groupService = new GroupService(this.socket, this.store, this.state);

        console.log("bound socket to client", this.clientConfig());

        // connection.
        this.socket.ev.on('connection.update', this.connection_update.bind(this));
        this.socket.ev.on('creds.update', this.saveCreds.bind(this));

        // contacts
        this.socket.ev.on('contacts.upsert', this.contacts_received.bind(this));
        this.socket.ev.on('contacts.update', this.contacts_updated.bind(this));
        
        // messages
        this.socket.ev.on('messaging-history.set', this.messaging_history.bind(this));
        this.socket.ev.on('messages.upsert', this.messages_upsert.bind(this));
        this.socket.ev.on('messages.update', this.messages_update.bind(this));

        // groups
        this.socket.ev.on('groups.upsert', this.groups_upsert.bind(this));
        this.socket.ev.on('group-participants.update', this.group_participants_update.bind(this));
        this.socket.ev.on('group.member-tag.update', this.group_member_tag_update.bind(this));

        // other.
        this.socket.ev.on('labels.edit', this.doNothing.bind(this));
        this.socket.ev.on('presence.update', this.doNothing.bind(this));
        this.socket.ev.on('message-receipt.update', this.doNothing.bind(this));

        // handle socket events.
        this.socket.ev.process(
	    	// events is a map for event name => event data
            async(events:Partial<BaileysEventMap>) => {
                if(
                    events["connection.update"] ||
                    events["creds.update"] ||
                    events["messaging-history.set"] ||
                    events["messages.upsert"] ||
                    events["messages.update"] ||
                    events["labels.edit"] ||
                    events["presence.update"] ||
                    events["message-receipt.update"] ||
                    events["contacts.update"] ||
                    events["groups.upsert"] ||
                    events["group-participants.update"] ||
                    events["group.member-tag.update"]
                ){
                    return;
                }

                // just spill everything for now.
                console.log("EVENT! ", JSON.stringify(events));
            }
        );

        // start album cleanup timer (check every 5 minutes)
        this.albumCleanupTimer = setInterval(() => this.cleanupTimedOutAlbums(), 5 * 60 * 1000);
        //*/
    }

    private async messages_upsert(upsert:UpsertMessage):Promise<void> {

        if(upsert.type === 'notify'){
            upsert.messages.forEach(message => this.message_received(message, true));
        }

        if(upsert.type === 'append'){
            upsert.messages.forEach(message => this.message_received(message, true));
        }
    }
    
    private async messages_update(updates: WAMessageUpdate[]): Promise<void> {
        for(const update of updates) {
            const loc = update.update.message?.liveLocationMessage;
            if(!loc) continue;

            const remoteJid = update.key.remoteJid!;
            const chat = await this.store.chats().get(remoteJid);

            const whatsappmessage: WhatsappMessage = {
                timestamp:  Date.now() / 1000,
                messageId:  update.key.id!,
                chat: {
                    id:   chat?.id   ?? remoteJid,
                    name: chat?.name ?? remoteJid,
                },
                sender: {
                    id:   update.key.participant ?? remoteJid,
                    name: update.key.participant ?? remoteJid,
                    me:   !!update.key.fromMe,
                },
                type:    MessageType.LiveLocation,
                payload: {
                    latitude:       loc.degreesLatitude,
                    longitude:      loc.degreesLongitude,
                    sequenceNumber: loc.sequenceNumber != null ? String(loc.sequenceNumber) : undefined,
                },
            };

            Object.values(this.messageSubscribers).forEach(sub => sub(whatsappmessage));
        }
    }

    private async groups_upsert(groups: GroupMetadata[]): Promise<void> {
        for(const group of groups) {
            const chat = await this.store.chats().create(
                group.id, "", ChatType.Group,
                group.owner ?? "", group.subject, group.desc ?? ""
            );

            for(const participant of group.participants) {
                const contactId = participant.phoneNumber ?? participant.id;
                const contact = await this.store.contacts().get(contactId);
                if(contact) {
                    chat.addParticipant(contact, WAClientHelper.parseRole(participant.admin));
                }
            }

            await this.store.chats().save(chat);
        }
    }

    private async group_participants_update(event: GroupParticipantsUpdate): Promise<void> {
        const groupId = event.id;
        const myJid = this.state.creds.me!.id.replace(/:\d+(?=@)/, "");

        if(event.action === "remove") {
            // check if the linked account itself was removed from the group.
            const selfRemoved = event.participants.some(p =>
                p.phoneNumber === myJid || p.id === myJid
            );

            if(selfRemoved) {
                console.log(`Linked account removed from group ${groupId} — deleting from store`);
                await this.store.chats().delete(groupId);
                return;
            }

            // remove other participants from the store.
            const contactIds = event.participants.map(p => p.phoneNumber ?? p.id);
            await this.store.chats().removeParticipants(groupId, contactIds);
        }
        else if(event.action === "add") {
            // load with participants relation — without it, addParticipant() initialises a fresh
            // empty array and orphanedRowAction:"delete" would wipe all existing members on save.
            const chat = await this.store.chats().getWithParticipants(groupId);
            if(chat) {
                for(const participant of event.participants) {
                    const contactId = participant.phoneNumber ?? participant.id;
                    const contact = await this.store.contacts().get(contactId);
                    if(contact) {
                        chat.addParticipant(contact, WAClientHelper.parseRole(participant.admin));
                    }
                }
                await this.store.chats().save(chat);
            }
        }
        else if(event.action === "promote" || event.action === "demote") {
            const role = event.action === "promote" ? Role.Admin : Role.Member;
            for(const participant of event.participants) {
                const contactId = participant.phoneNumber ?? participant.id;
                await this.store.chats().updateParticipantRole(groupId, contactId, role);
            }
        }
    }

    private async group_member_tag_update(event: GroupMemberTagUpdate): Promise<void> {
        const contactId = event.participantAlt ?? event.participant;
        await this.store.chats().updateParticipantLabel(event.groupId, contactId, event.label);
    }

    private async connection_update(update: Partial<ConnectionState>):Promise<void> {
        if(update.connection === 'close') {
            const statusCode = (update.lastDisconnect?.error as Boom)?.output?.statusCode;

            if(statusCode === DisconnectReason.loggedOut) {
                console.log(`WhatsApp [${this.config.localConnectionId}]: logged out.`);
                return;
            }

            // restartRequired (515) is the normal post-QR-scan restart; use a shorter backoff.
            // All other close reasons (network drop, WebSocket error, etc.) use a longer backoff.
            const delayMs = statusCode === DisconnectReason.restartRequired ? 3000 : 5000;
            this.scheduleReconnect(delayMs, statusCode);
            return;
        }

        if(update.connection === 'open') {
            console.log(`WhatsApp [${this.config.localConnectionId}]: connected.`);
            this.onConnectionSuccessListeners.forEach(listener => listener());

            // fetch recent message history on connect.
            let count = 10;
            let oldestMessageKey = {};
            let oldestMessageTimestamp = new Date().getTime() - (10 * 24 * 60 * 1000);
            this.socket.fetchMessageHistory(count, oldestMessageKey, oldestMessageTimestamp);
        }

        if(update.qr){
            // uncomment to render QRCode to console
            // QRCode.toString(update.qr, {type:"terminal"}, function (err:any, imageString:any) {
            //     if (err) throw err
            //     console.log(imageString);
            // })
            this.currentQRCode = update.qr;
            this.onQRCodeListeners.forEach(listener => listener(update.qr));
        }
    }

    private scheduleReconnect(delayMs: number, statusCode: number | undefined): void {
        if(this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }
        console.log(`WhatsApp [${this.config.localConnectionId}]: connection closed (code: ${statusCode}). Reconnecting in ${delayMs / 1000}s...`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.start();
        }, delayMs);
    }

    /**
     * Normalises a JID for outbound sending:
     *   - @lid  → resolves to phone-number JID via the contact store
     *   - contains "@" → assumed to be a fully-qualified JID; passed through unchanged
     *   - otherwise → treated as a bare phone number; non-digits are stripped and
     *                 "@s.whatsapp.net" is appended (works for arbitrary contacts too)
     */
    public async resolveJid(jid: string): Promise<string> {
        if (jid.endsWith("@lid")) {
            const contact = await this.store.contacts().getByLid(jid);
            if (contact) return contact.id;
            console.log(`resolveJid: cannot resolve LID ${jid} — sending as-is`);
            return jid;
        }

        if (jid.includes("@")) return jid;

        // Bare phone number — strip formatting characters and construct JID
        const digits = jid.replace(/\D/g, "");
        return `${digits}@s.whatsapp.net`;
    }

    public async stop(){
        if(this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        if(this.albumCleanupTimer) {
            clearInterval(this.albumCleanupTimer);
            this.albumCleanupTimer = undefined;
        }
        return this.socket.logout();
    }

    private cleanupTimedOutAlbums(): void {
        const now = Date.now();
        for(const [chatId, album] of this.pendingAlbums) {
            if(now - album.createdAt > ALBUM_TIMEOUT_MS) {
                console.log(`Album timeout: finalizing album ${album.albumMessageId} for chat ${chatId} (received ${album.receivedImages}/${album.expectedImages} images, ${album.receivedVideos}/${album.expectedVideos} videos)`);
                this.pendingAlbums.delete(chatId);
            }
        }
    }

    private async contacts_received(contacts:Contact[]):Promise<void>{
        // sample { "id": "<phone>@s.whatsapp.net", "notify": "<name>" },
        // sample { "id": "<groupid>@g.us", "name": "<group_name>" },
        // sample { "id": "0@s.whatsapp.net", "name": "WhatsApp Business" },
        // sample { "id": "<phone>@s.whatsapp.net", "phoneNumber": "<phone>@s.whatsapp.net", "verifiedName": "<business_name>" },

        await Promise.all(contacts.map(async newContact => {
            // find the contact by id.

            if(newContact.id.endsWith("@lid")){
                console.log("contacts_received: FOUND Contact referenced by lid",  newContact);
            }

            let contact = await this.store.contacts().get(newContact.id);

            // update the phone number
            if(newContact.phoneNumber)  { contact.phoneNumber = newContact.phoneNumber };
            
            // verified name > name > notify;
            if(newContact.verifiedName)  { contact.name = newContact.verifiedName };
            if(newContact.name && !newContact.verifiedName)  { contact.name = newContact.name };
            if(newContact.notify && !newContact.name && !newContact.verifiedName)  { contact.name = newContact.name };
            
            // set the lid.
            if(newContact.lid) { contact.lid = newContact.lid };
            return this.store.contacts().save(contact);
        }));
    }

    private async contacts_updated(contacts:Partial<Contact>[]):Promise<void>{
        // sample 'contacts.update': [ { id: '94953791303764@lid', imgUrl: 'changed' } ]
        console.log("Handle Contacts.Updated", JSON.stringify(contacts));
    }
    
    private async messaging_history(history: Partial<MessageingHistory>):Promise<void> {
        if(history.contacts) {
            await this.contacts_received(history.contacts);
        }
        
        if(history.chats) {
            await this.chats_receieved(history.chats);
        }

        if(history.messages) {
            await Promise.all(history.messages.map(async message => {
                return this.message_received(message, false);
            }));
        }
    }

    private async chats_receieved(chats:WAChat[]):Promise<void>{
        await Promise.all(chats.map(async chat => {
            //console.log("new chat: ", JSON.stringify(chat));

            let id = chat.id!;
            let type = (id.endsWith("@g.us")) ? ChatType.Group : ChatType.Conversation;
            let lid = id.endsWith("@lid") ? id : "";

            let persistedChat:Chat;

            if(type === ChatType.Group){
                // fetch the chat / group metadata.
                let metadata = await this.socket.groupMetadata(chat.id!);
                //console.log("CHAT GROUP METADATA", JSON.stringify(metadata, null, 2));

                // persist the chat.
                persistedChat = await this.store.chats().create(id, lid, type, metadata.owner!, metadata.subject, metadata.desc!);
                
                for(let participant of metadata.participants){

                    if(participant.phoneNumber && participant.phoneNumber.endsWith("@lid")){
                        console.log("chats_receieved: FOUND Contact referenced by lid",  participant.phoneNumber);
                    }

                    // the phone number will usually be included.
                    let contact = await this.store.contacts().get(participant.phoneNumber!);

                    if(!contact){
                        console.log("contact " + participant.id + " not found for chat " + chat.id, metadata);
                    }
                    else{
                        //console.log("adding participant ", persistedChat.id, participant);
                        persistedChat.addParticipant(contact, WAClientHelper.parseRole(participant.admin));
                    }
                }
                this.store.chats().save(persistedChat);
            }

            if(type === ChatType.Conversation){
                persistedChat = await this.store.chats().create(id, lid, type, "", "", "");
                this.store.chats().save(persistedChat);
            }

            // after persisting the chat, check if it has some messages attached to it.
            let messages = chat.messages ? chat.messages.map(message => message.message) : [];
            return await Promise.all(messages.map(message => {
                return this.message_received(message!, false);
            })).then(() => persistedChat);
        }));
    }

    private async message_received(message:proto.IWebMessageInfo, live: boolean = true):Promise<void>{
        // skip protocol messages (internal WhatsApp sync, not user messages)
        if(message.message?.protocolMessage) {
            return;
        }
        // skip MASK_LINKED_DEVICES placeholder — internal linked-device notification, not a user message
        if(message.message?.placeholderMessage?.type === proto.Message.PlaceholderMessage.PlaceholderType.MASK_LINKED_DEVICES) {
            return;
        }

        // find the chat for this message.
        let chat = await this.store.chats().get(message.key?.remoteJid!);
        let id = message.key?.id!;
        let timestamp = message.messageTimestamp ? Number(message.messageTimestamp) : 0;

        // verify the chat object.
        if(!chat){
            console.log("could not find chat for", JSON.stringify(message.key));
            return;
        }

        // lookup sender contact
        let sender = await this.lookupOrCreateSender(message);

        // figure out the type of the message.
        let messageType =
            message.message?.conversation ? MessageType.Text :
            message.message?.imageMessage ? MessageType.Image :
            message.message?.videoMessage ? MessageType.Video :
            message.message?.documentMessage ? MessageType.Document :
            message.message?.templateMessage ? MessageType.Template :
            message.message?.interactiveMessage ? MessageType.Interactive :
            message.message?.extendedTextMessage ? MessageType.ExtendedText :
            message.message?.albumMessage ? MessageType.Album :
            message.message?.contactMessage ? MessageType.Contact :
            message.message?.locationMessage ? MessageType.Location :
            message.message?.liveLocationMessage ? MessageType.LiveLocation :
            message.message?.eventMessage ? MessageType.Event :
            message.message?.encEventResponseMessage ? MessageType.EventResponse :
            message.message?.stickerMessage ? MessageType.Sticker :
            message.messageStubType ? MessageType.Stub :
            MessageType.Unknown;

        if(messageType === MessageType.Unknown){
            if(proto.WebMessageInfo.StubType.BIZ_PRIVACY_MODE_TO_FB === message.messageStubType){
                return;
            }
        }
        
        let messageContents;
        let subscriberPayload: object | undefined;  // for image/video, includes binary data not stored in db

        // handle a text message.
        if(messageType === MessageType.Text){
            messageContents = { text: message.message?.conversation};
        }

        // handle an image message.
        if(messageType === MessageType.Image){
            let chatId = message.key?.remoteJid!;
            let albumId: string | undefined = undefined;

            // check for pending album
            let pendingAlbum = this.pendingAlbums.get(chatId);
            if(pendingAlbum) {
                albumId = pendingAlbum.albumMessageId;
                pendingAlbum.receivedImages++;
                pendingAlbum.mediaIds.push(id);

                // check if album is complete
                if(pendingAlbum.receivedImages >= pendingAlbum.expectedImages &&
                   pendingAlbum.receivedVideos >= pendingAlbum.expectedVideos) {
                    console.log(`Album complete: ${albumId} with ${pendingAlbum.mediaIds.length} media items`);
                    this.pendingAlbums.delete(chatId);
                }
            }

            // extract metadata from image message
            const imageMsg = message.message?.imageMessage!;
            messageContents = {
                mimetype: imageMsg.mimetype,
                width: imageMsg.width,
                height: imageMsg.height,
                fileLength: imageMsg.fileLength ? Number(imageMsg.fileLength) : undefined,
                caption: imageMsg.caption,
                albumId: albumId,
            };

            // only download media for live messages — historical URLs expire quickly and will 403
            if(live) {
                try {
                    const imageData = await downloadMediaMessage(
                        message as WAMessage,
                        'buffer',
                        {},
                        { logger: this.logger, reuploadRequest: this.socket.updateMediaMessage }
                    );
                    subscriberPayload = { ...messageContents, data: imageData };
                } catch(error) {
                    console.log("Failed to download image:", error);
                    subscriberPayload = { ...messageContents, data: null };
                }
            }
        }

        // handle a video message.
        if(messageType === MessageType.Video){
            let chatId = message.key?.remoteJid!;
            let albumId: string | undefined = undefined;

            // check for pending album
            let pendingAlbum = this.pendingAlbums.get(chatId);
            if(pendingAlbum) {
                albumId = pendingAlbum.albumMessageId;
                pendingAlbum.receivedVideos++;
                pendingAlbum.mediaIds.push(id);

                // check if album is complete
                if(pendingAlbum.receivedImages >= pendingAlbum.expectedImages &&
                   pendingAlbum.receivedVideos >= pendingAlbum.expectedVideos) {
                    console.log(`Album complete: ${albumId} with ${pendingAlbum.mediaIds.length} media items`);
                    this.pendingAlbums.delete(chatId);
                }
            }

            // extract metadata from video message
            const videoMsg = message.message?.videoMessage!;
            messageContents = {
                mimetype: videoMsg.mimetype,
                width: videoMsg.width,
                height: videoMsg.height,
                fileLength: videoMsg.fileLength ? Number(videoMsg.fileLength) : undefined,
                seconds: videoMsg.seconds,
                caption: videoMsg.caption,
                albumId: albumId,
            };

            // only download media for live messages — historical URLs expire quickly and will 403
            if(live) {
                try {
                    const videoData = await downloadMediaMessage(
                        message as WAMessage,
                        'buffer',
                        {},
                        { logger: this.logger, reuploadRequest: this.socket.updateMediaMessage }
                    );
                    subscriberPayload = { ...messageContents, data: videoData };
                } catch(error) {
                    console.log("Failed to download video:", error);
                    subscriberPayload = { ...messageContents, data: null };
                }
            }
        }

        if(messageType === MessageType.Document) {
            const docMsg = message.message?.documentMessage!;
            messageContents = {
                filename:  docMsg.fileName,
                mimetype:  docMsg.mimetype,
                fileLength: docMsg.fileLength ? Number(docMsg.fileLength) : undefined,
                pageCount: docMsg.pageCount,
                caption:   docMsg.caption,
            };

            if(live) {
                try {
                    const documentData = await downloadMediaMessage(
                        message as WAMessage,
                        'buffer',
                        {},
                        { logger: this.logger, reuploadRequest: this.socket.updateMediaMessage }
                    );
                    subscriberPayload = { ...messageContents, data: documentData };
                } catch(error) {
                    console.log("Failed to download document:", error);
                    subscriberPayload = { ...messageContents, data: null };
                }
            }
        }

        if(messageType === MessageType.Template){
            // the sensible way to handle this for now is to change it to a Text Mesasge.
            messageContents = { 
                contentText: message.message!.templateMessage!.hydratedTemplate!.hydratedContentText,
                footerText: message.message!.templateMessage!.hydratedTemplate!.hydratedFooterText,
                commands: [] as any[]
            }

            if(message.message!.templateMessage!.hydratedTemplate!.hydratedButtons){
                for(let button of message.message!.templateMessage!.hydratedTemplate!.hydratedButtons){
                    if(button.urlButton){
                        messageContents.commands.push({text:button.urlButton.displayText, url:button.urlButton.url})
                        continue;
                    }
                    if(button.quickReplyButton){
                        messageContents.commands.push({text:button.quickReplyButton.displayText, id:button.quickReplyButton.id})
                        continue;
                    }
                    console.log("UNHANDLED TEMPLATE BUTTON", message.message!.templateMessage!.hydratedTemplate!.hydratedButtons)
                }
            }
        }

        if(messageType === MessageType.Interactive){
            let msg = message.message!.interactiveMessage!;
            messageContents = { 
                headerText: msg.header,
                contentText: msg.body,
                footerText:msg.footer,
                commands: [] as any[],
            };

            if(msg.nativeFlowMessage?.buttons){
                for(let button of msg.nativeFlowMessage.buttons){
                    if(button.buttonParamsJson){
                        let buttonMarkup = JSON.parse(button.buttonParamsJson);
                        messageContents.commands.push({text:buttonMarkup.display_text, url:buttonMarkup.url})
                        continue;
                    }
                    console.log("UNHANDLED nativeFlowMessage BUTTON", msg)
                }
            }
            if(msg.carouselMessage || msg.collectionMessage || msg.shopStorefrontMessage || msg.contextInfo || msg.urlTrackingMap){
                console.log("UNHANDLED interactiveMessage Component", msg);
            }
        }

        if(messageType === MessageType.ExtendedText) {
            messageContents = { text: message.message?.extendedTextMessage?.text};
        }

        // handle an album message.
        if(messageType === MessageType.Album) {
            let chatId = message.key?.remoteJid!;

            // if there's already a pending album for this chat, finalize it
            if(this.pendingAlbums.has(chatId)) {
                console.log(`Album interrupted: finalizing previous album for chat ${chatId}`);
                this.pendingAlbums.delete(chatId);
            }

            // create new pending album
            let albumMessage = message.message?.albumMessage!;
            this.pendingAlbums.set(chatId, {
                chatId: chatId,
                albumMessageId: id,
                expectedImages: albumMessage.expectedImageCount ?? 0,
                expectedVideos: albumMessage.expectedVideoCount ?? 0,
                receivedImages: 0,
                receivedVideos: 0,
                createdAt: Date.now(),
                mediaIds: []
            });

            messageContents = {
                expectedImages: albumMessage.expectedImageCount,
                expectedVideos: albumMessage.expectedVideoCount
            };
        }

        if(messageType === MessageType.Contact){
            messageContents = { 
                name: message.message?.contactMessage?.displayName,
                vcard: message.message?.contactMessage?.vcard,
            };
        }

        if(messageType === MessageType.Location){
            const loc = message.message?.locationMessage!;
            messageContents = {
                latitude:  loc.degreesLatitude,
                longitude: loc.degreesLongitude,
            };
        }

        if(messageType === MessageType.LiveLocation){
            const loc = message.message?.liveLocationMessage!;
            messageContents = {
                latitude:        loc.degreesLatitude,
                longitude:       loc.degreesLongitude,
                sequenceNumber:  loc.sequenceNumber != null ? String(loc.sequenceNumber) : undefined,
            };
        }

        if(messageType === MessageType.Event){
            const evt = message.message?.eventMessage!;
            const secret = message.message?.messageContextInfo?.messageSecret;
            messageContents = {
                name:              evt.name,
                description:       evt.description,
                startTime:         evt.startTime ? Number(evt.startTime) : undefined,
                isCanceled:        evt.isCanceled,
                hasReminder:       evt.hasReminder,
                reminderOffsetSec: evt.reminderOffsetSec ? Number(evt.reminderOffsetSec) : undefined,
                extraGuestsAllowed: evt.extraGuestsAllowed,
                isScheduleCall:    evt.isScheduleCall,
                messageSecret:     secret ? Buffer.from(secret).toString('base64') : undefined,
            };
        }

        if(messageType === MessageType.EventResponse){
            const encResp = message.message?.encEventResponseMessage!;
            const creationKey = encResp.eventCreationMessageKey!;

            const originalMessage = await this.store.messages().get(creationKey.id!);
            const originalPayload = originalMessage ? JSON.parse(originalMessage.payload) : null;
            const messageSecretB64: string | undefined = originalPayload?.messageSecret;

            if(!messageSecretB64) {
                console.log("encEventResponseMessage: missing messageSecret for event", creationKey.id);
                messageContents = { eventMessageId: creationKey.id, response: "unknown" };
            } else {
                try {
                    // WhatsApp LID-addressed clients use raw LIDs (not resolved phone numbers) in key derivation.
                    const eventCreatorJid = creationKey.participant || creationKey.remoteJid || "";
                    const responderJid    = message.key?.participant || message.key?.remoteJid || "";

                    const responseMsg = decryptEventResponse(
                        { encPayload: encResp.encPayload!, encIv: encResp.encIv! },
                        {
                            eventEncKey:    Buffer.from(messageSecretB64, 'base64'),
                            eventCreatorJid,
                            eventMsgId:     creationKey.id!,
                            responderJid,
                        }
                    );

                    const responseType = responseMsg.response;
                    const responseStr =
                        responseType === proto.Message.EventResponseMessage.EventResponseType.GOING      ? "going" :
                        responseType === proto.Message.EventResponseMessage.EventResponseType.NOT_GOING  ? "not_going" :
                        responseType === proto.Message.EventResponseMessage.EventResponseType.MAYBE      ? "maybe" :
                        "unknown";

                    messageContents = {
                        eventMessageId:  creationKey.id,
                        response:        responseStr,
                        timestampMs:     responseMsg.timestampMs ? Number(responseMsg.timestampMs) : undefined,
                        extraGuestCount: responseMsg.extraGuestCount ?? undefined,
                    };
                } catch(error) {
                    console.log("encEventResponseMessage: decryption failed", error);
                    messageContents = { eventMessageId: creationKey.id, response: "unknown" };
                }
            }
        }

        if(messageType === MessageType.Sticker) {
            const stickerMsg = message.message?.stickerMessage!;
            messageContents = {
                mimetype:    stickerMsg.mimetype,
                width:       stickerMsg.width,
                height:      stickerMsg.height,
                fileLength:  stickerMsg.fileLength ? Number(stickerMsg.fileLength) : undefined,
                isAnimated:  stickerMsg.isAnimated,
                isLottie:    stickerMsg.isLottie,
                isAiSticker: stickerMsg.isAiSticker,
            };

            if(live) {
                try {
                    const stickerData = await downloadMediaMessage(
                        message as WAMessage,
                        'buffer',
                        {},
                        { logger: this.logger, reuploadRequest: this.socket.updateMediaMessage }
                    );
                    subscriberPayload = { ...messageContents, data: stickerData };
                } catch(error) {
                    console.log("Failed to download sticker:", error);
                    subscriberPayload = { ...messageContents, data: null };
                }
            }
        }

        if(messageType === MessageType.Stub){
            // stub message. doesnt do much by the looks of it.

        }

        if(messageType === MessageType.Unknown){
            console.log("unkown new message: ", JSON.stringify(message, null, 2));
        }

        // persist the message.
        await this.store.messages().create(chat!, id, timestamp, messageType, JSON.stringify(messageContents, null, 2));
        
        // send the message to the subscribers.
        let whatsappmessage:WhatsappMessage = {
            timestamp:timestamp,
            messageId:id,
            chat:{
                id:chat!.id,
                name:chat!.name,
            },
            sender:{
                id: sender?.id ?? "unknown",
                name: sender?.getName() ?? "unknown",
                me: !!message.key?.fromMe
            },
            type:messageType,
            payload: subscriberPayload ?? messageContents as object,
        }

        Object.values(this.messageSubscribers).forEach(subscriber => subscriber(whatsappmessage) )
    }

    /**
     * Lookup or create the sender contact from a message.
     * For received messages, uses lid-based lookup first (if addressingMode is "lid"),
     * then falls back to id-based lookup.
     * Creates a new contact if not found, and back-populates the name from pushName if missing.
     */
    private async lookupOrCreateSender(message: proto.IWebMessageInfo): Promise<StoredContact | null> {
        const key = message.key;
        if (!key) return null;

        const participant = key.participant as string | undefined;        // lid format: "<lid>@lid"
        const participantAlt = (key as any).participantAlt as string | undefined;  // id format: "<phone>@s.whatsapp.net"
        const addressingMode = (key as any).addressingMode as string | undefined;
        const pushName = message.pushName;

        let contact: StoredContact | null = null;

        // Try lid-based lookup first if addressingMode is "lid"
        if (addressingMode === "lid" && participant) {
            contact = await this.store.contacts().getByLid(participant);
        }

        // Fall back to id-based lookup using participantAlt
        if (!contact && participantAlt) {
            contact = await this.store.contacts().get(participantAlt);
        }

        // If still not found and we have participantAlt, create a new contact
        if (!contact && participantAlt) {
            contact = await this.store.contacts().create(participantAlt);
            // Set the lid if we have it
            if (participant && addressingMode === "lid") {
                contact.lid = participant;
            }
        }

        // Back-populate name from pushName if the contact exists but has no name
        if (contact && pushName && !contact.name) {
            contact.name = pushName;
        }

        // Save any updates
        if (contact) {
            await this.store.contacts().save(contact);
        }

        return contact;
    }

    private async doNothing(message:any):Promise<void>{
        // do nothing.
    }
}

type MessageingHistory = {
    chats: WAChat[];
    contacts: Contact[];
    messages: WAMessage[];
    isLatest?: boolean;
    progress?: number | null;
    syncType?: proto.HistorySync.HistorySyncType | null;
    peerDataRequestSessionId?: string | null;
}

type UpsertMessage = {
    messages: WAMessage[];
    type: MessageUpsertType;
    requestId?: string;
}

type GroupParticipantsUpdate = {
    id: string;
    author: string;
    authorPn?: string;
    authorUsername?: string;
    participants: GroupParticipant[];
    action: ParticipantAction;
}

type GroupMemberTagUpdate = {
    groupId: string;
    participant: string;
    participantAlt?: string;
    label: string;
    messageTimestamp?: number;
}


class GroupService {

    private store: WhatsappStore
    private socket: WASocket;
    private state: AuthenticationState;

    constructor(socket:WASocket, store: WhatsappStore, state: AuthenticationState){
        this.socket = socket;
        this.store = store;
        this.state = state;
    }

    public async getAll():Promise<Group[]> {
        // creds.me is only populated after authentication — guard against undefined for new accounts.
        const myJid = this.state.creds.me?.id.replace(/:\d+(?=@)/, "") ?? "";
        return this.store.chats().getGroups()
            .then(groups =>  groups
            .map(groups => ({
                id:groups.id,
                subject:groups.name,
                participants: (!groups.participants) ? [] : groups.participants.map(p => ({
                    id:p.contact.id,
                    name: p.contact.name ?? "",
                    role: p.role,
                    label: p.label,
                    isMe: myJid !== "" && p.contact.id === myJid,
                }))
            }))
        );
    }

    public async createGroup(subject:string):Promise<Group>{
        let group = await this.socket.groupCreate(subject, []);
        return {
            id: group.id,
            subject: group.subject,
            participants: group.participants.map(p => ({
                id: p.id,
                role:WAClientHelper.parseRole(p.admin)
            }))
        }
    }

    /**
     * Add a user as a participant to a group.
     * @param userId the Id of the user. should be in the phonenumber format: <phone>@s.whatsapp.net
     * @param groupId the groupId. it is expectedd that the group is known and can be added to at this point.
     * @param role the role that the user should be assigned.
     * @returns nothing.
     */
    public async addUserToGroup(userId:string, groupId:string, role:Role):Promise<void>{
        let group = this.store.chats().get(groupId);
        if(!group){
            console.log(`addUserToGroup: group '${groupId}' not found`)
            return;
        }
        await this.socket.groupParticipantsUpdate(groupId, [userId], 'add');
        
        // promote the user if need be.
        if(role !== Role.Member){
            await this.socket.groupParticipantsUpdate(groupId, [userId], "promote");
        }
        return;
    }

    /**
     * Update a user's role in a group.
     * @param userId the Id of the user. should be in the phonenumber format: <phone>@s.whatsapp.net
     * @param groupId the groupId.
     * @param role the new role for the user.
     */
    public async updateUserRole(userId: string, groupId: string, role: Role): Promise<void> {
        if(role === Role.Member) {
            await this.socket.groupParticipantsUpdate(groupId, [userId], 'demote');
        }
        else {
            await this.socket.groupParticipantsUpdate(groupId, [userId], 'promote');
        }
    }

    /**
     * Remove a user from a group.
     * @param userId the Id of the user. should be in the phonenumber format: <phone>@s.whatsapp.net
     * @param groupId the groupId. it is expectedd that the group is known and can be added to at this point.
     * @returns nothing
     */
    public async removeUserFromGroup(userId: string, groupId: string) {
        let group = this.store.chats().get(groupId);
        if(!group){
            console.log(`addUserToGroup: group '${groupId}' not found`)
            return;
        }
        await this.socket.groupParticipantsUpdate(groupId, [userId], 'remove');
        return;
    }
}

class WAClientHelper {
    static parseRole(value: string | null | undefined): any {
        if(!value){
            return Role.Member;
        }
        
        if(value.toLocaleLowerCase() === "admin") {
            return Role.Admin;
        }

        return Role.SuperAdmin;
    }
    
}

export class GroupClient {
    
    private _client: WhatsappClient;
    private _id: string;

    public constructor(client:WhatsappClient, id:string){
        this._client = client;
        this._id = id;
    }

    public id(){
        return this._id;
    }

    public subscribe(subscription: Subscription) {
        this._client.subscribe(subscription, {groupId:this.id()});
    }

    public unsubscribe(subscription: Subscription) {
        this._client.unsubscribe(subscription);
    }

    public sendMessage(message: WhatsappSendMessageRequest) {
        this._client.sendMessage(this.id(), message);
    }
}

export type Group = {
    id:string,
    subject:string,
    participants:{
        id:string
        name?:string
        role: Role
        label?: string
        isMe?: boolean
    }[],
}

export enum ChatType {
    Group = "Group",
    Conversation = "Conversation",
}

export type Subscription = (message: WhatsappMessage) => void;