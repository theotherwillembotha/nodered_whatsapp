import { time } from "console";
import { Column, DataSource, Entity, EntityManager, JoinTable, ManyToMany, ManyToOne, OneToMany, PrimaryColumn, PrimaryGeneratedColumn } from "typeorm";
import { ChatType } from "./WhatsappClient";

// ******************* WHATSAPP STORE ********************** //
export class WhatsappStore implements DAOService {

    public static async createStore(id:string, location:string):Promise<WhatsappStore>{
        let datasource = await new DataSource({
            type: "sqljs",
            location: `${location}/database.sqlite`,
            synchronize: true,
            logging: false,
            autoSave: true,
            entities: [Contact, Chat, Message, Participant],
            migrations: [],
            subscribers: [],
        }).initialize();

        return new WhatsappStore(id, location, datasource);
    }

    private _id: string;
    private _location: string;
    private _datasource: DataSource;

    private _contacts: ContactDAO;
    private _chats: ChatDAO;
    private _messages: MessageDAO;

    private constructor(id:string, location:string, datasource:DataSource){
        this._id = id;
        this._location = location;
        this._datasource = datasource;

        this._contacts = new ContactDAO(this, this._datasource.manager);
        this._chats = new ChatDAO(this, this._datasource.manager);
        this._messages = new MessageDAO(this, this._datasource.manager);

        // print out some db stats.
        this.contacts().all().then(contacts => console.log("DB CONTAINS " + contacts.length + " CONTACTS"))
        this.chats().all().then(chats => console.log("DB CONTAINS " + chats.length + " CHATS"))
        this.messages().all().then(messages => console.log("DB CONTAINS " + messages.length + " MESSAGES"))
    }

    public chats():ChatDAO{
        return this._chats;
    }

    public contacts():ContactDAO{
        return this._contacts;
    }

    public messages():MessageDAO{
        return this._messages;
    }
}

interface DAOService {
    chats():ChatDAO;
    contacts():ContactDAO;
    messages():MessageDAO;
}

abstract class DAO<EntityType> {
    
    private _daos: DAOService;
    private _em: EntityManager;

    constructor(daos:DAOService, em:EntityManager){
        this._daos = daos;
        this._em = em;
    }

    protected daos(){
        return this._daos;
    }

    protected em(){
        return this._em;
    }

    abstract get(id:string):Promise<EntityType|null>;
    abstract all():Promise<EntityType[]>;
    abstract create(...params:any):Promise<EntityType>;
}

enum ContactType {
    USER = "USER",
    GROUP = "GROUP"
    
}

// ******************* CONTACTS ********************** //
@Entity()
class Contact {
    
    /**
     * Account ID of the whatsapp user eg: "<phone>@s.whatsapp.net"
     */
    @PrimaryColumn({name:"id"})
    id!: string

    @Column({name:"type", nullable:false})
    type?: ContactType

    @Column({name:"phoneNumber", nullable:true})
    phoneNumber?: string;

    @Column({name:"name", nullable:true})
    name?: string

    @Column({name:"lid", nullable:true})
    lid?: string

    @OneToMany(() => Participant, (participant) => participant.chat)
    participants!: Participant[]

    constructor(id:string){
        if(!id){
            return;
        }

        this.id = id;

        // the ID will determine the type of the contact. if ends with "@g.us" its a group. if it ends with @s.whatsapp.net, its a user.
        this.type = 
            id.endsWith("@s.whatsapp.net") ? ContactType.USER : 
            id.endsWith("@lid") ? ContactType.USER : 
            ContactType.GROUP;

        // the phone number is the bits before the @ in the id.
        this.phoneNumber = id.substring(0, id.indexOf("@"))
    }

    getName(): string | undefined {
        return this.name ? this.name : this.phoneNumber;
    }
}

class ContactDAO extends DAO<Contact>{

    constructor(daos:DAOService, em:EntityManager){
        super(daos, em);
    }

    // get will always return a contact, whether it exists or not.
    async get(id: string):Promise<Contact> {
        let contact = await this.em().findOne(Contact, {where:{id:id}});
        return contact ? contact : this.em().save(new Contact(id));
    }

    async all():Promise<Contact[]> {
        return this.em().find(Contact);
    }

    async create(id:string):Promise<Contact> {
        // first check if the client exists.
        let contact = await this.em().findOne(Contact, {where:{id:id}});
        if(contact){
            return contact;
        }

        return this.em().save(new Contact(id));
    }

    async save(contact:Contact):Promise<Contact> {
        return this.em().save(contact);
    }

    async getByLid(lid: string): Promise<Contact | null> {
        return this.em().findOne(Contact, {where:{lid:lid}});
    }
}

export enum Role {
    Admin = "Admin",
    SuperAdmin = "SuperAdmin",
    Member = "Member",
}

// ******************* CHAT ********************** //
@Entity()
class Chat {

    @PrimaryColumn({name:"id"})
    id: string

    @Column({name:"type", nullable:true})
    type: string;

    @Column({name:"lid", nullable:true})
    lid: string;

    @Column({name:"owner", nullable:true})
    owner: string;
    
    @Column({name:"name", nullable:true})
    name: string;

    @Column({name:"description", nullable:true})
    description: string;

    @OneToMany(() => Participant, (participant) => participant.chat, {cascade:["insert", "update"], onDelete:"CASCADE", orphanedRowAction:"delete"})
    participants!: Participant[]

    @OneToMany(() => Message, (message) => message.chat)
    messages!: Message[]

    public constructor(id:string, lid:string, type:ChatType, owner:string, name:string, description:string){
        this.id = id;
        this.type = type;
        this.lid = lid;
        this.owner = owner;
        this.name = name;
        this.description = description;
    }

    public addParticipant(contact: Contact, role: Role): Chat {
        if(!this.participants){
            this.participants = [];
        }
        this.participants.push(new Participant(this, contact, role));
        return this;
    }
}

class ChatDAO extends DAO<Chat>{

    constructor(daos:DAOService, em:EntityManager){
        super(daos, em);
    }

    async get(id: string):Promise<Chat|null> {
        // if the id ends with @lid, then do a lookup by lid instead.
        return (id.endsWith("@lid")) 
            ? this.em().findOne(Chat, {where:{lid:id}})
            : this.em().findOne(Chat, {where:{id:id}});
    }

    async all():Promise<Chat[]> {
        return this.em().find(Chat, {});
    }

    async create(id:string, lid:string, type:ChatType, owner:string, name:string, description:string):Promise<Chat> {
        let chat = await this.em().findOneBy(Chat, { id:id });
        if(chat){
            // update the chat if some properties changed.
            if(chat.name !== name){
                chat.name = name;
                return this.em().save(chat);
            }
            else{
                return chat;
            }
        }

        return this.em().save(new Chat(id, lid, type, owner, name, description));
    }

    async getWithParticipants(id: string):Promise<Chat|null> {
        return this.em().findOne(Chat, {
            where: { id },
            relations: ['participants', 'participants.contact']
        });
    }

    async getGroups():Promise<Chat[]> {
        return this.em().find(Chat, {
            where: { type: ChatType.Group },
            relations: ['participants', 'participants.contact']
        });
    }

    async save(chat:Chat):Promise<Chat>{
        return this.em().save(chat);
    }

    async delete(chatId: string):Promise<void> {
        const chat = await this.em().findOne(Chat, { where: { id: chatId }, relations: ['participants'] });
        if(chat) {
            await this.em().remove(chat);
        }
    }

    async removeParticipants(chatId: string, contactIds: string[]): Promise<void> {
        const chat = await this.em().findOne(Chat, {
            where: { id: chatId },
            relations: ['participants', 'participants.contact']
        });
        if(!chat) return;
        chat.participants = chat.participants.filter(p => !contactIds.includes(p.contact.id));
        await this.em().save(chat);
    }

    async updateParticipantRole(chatId: string, contactId: string, role: Role): Promise<void> {
        const chat = await this.em().findOne(Chat, {
            where: { id: chatId },
            relations: ['participants', 'participants.contact']
        });
        if(!chat) return;
        const participant = chat.participants.find(p => p.contact.id === contactId);
        if(participant) {
            participant.role = role;
            await this.em().save(participant);
        }
    }

    async updateParticipantLabel(chatId: string, contactId: string, label: string): Promise<void> {
        const chat = await this.em().findOne(Chat, {
            where: { id: chatId },
            relations: ['participants', 'participants.contact']
        });
        if(!chat) return;
        const participant = chat.participants.find(p => p.contact.id === contactId);
        if(participant) {
            participant.label = label;
            await this.em().save(participant);
        }
    }
}

// ******************* PARTICIPANT *************************** //

@Entity()
class Participant {

    @PrimaryGeneratedColumn({name:"id"})
    id!: string

    @ManyToOne(() => Chat, (chat) => chat.participants)
    chat : Chat

    @ManyToOne(() => Contact, (contact) => contact.participants)
    contact : Contact

    @Column({nullable:true})
    role:Role;

    @Column({type:"varchar", nullable:true})
    label: string | undefined;

    public constructor(chat:Chat, contact:Contact, role:Role){
        this.chat = chat;
        this.contact = contact;
        this.role = role;
    }
}

// ******************* MESSAGES ********************** //
@Entity()
class Message {

    @PrimaryColumn({name:"id"})
    id: string

    @ManyToOne(() => Chat, (chat) => chat.messages)
    chat: Chat;

    @Column({nullable:true})
    timestamp:number;

    @Column({nullable:true})
    type: MessageType;

    @Column({nullable:true})
    payload: string;

    constructor(id:string, chat:Chat, timestamp:number, type:MessageType, payload:string){
        this.id = id;
        this.chat = chat;
        this.timestamp = timestamp;
        this.type = type;
        this.payload = payload;
    }
}

class MessageDAO extends DAO<Message>{

    constructor(daos:DAOService, em:EntityManager){
        super(daos, em);
    }

    async get(id: string):Promise<Message|null> {
        return this.em().findOne(Message, {where:{id:id}});
    }

    async all():Promise<Message[]> {
        return this.em().find(Message);
    }

    async create(chat:Chat, id:string, timestamp:number, type:MessageType, payload:string):Promise<Message> {
        // first check if the client exists.
        let message = await this.em().findOneBy(Message, { id:id, chat:chat });
        if(message){
            let modified = true;
            if(message.timestamp !== timestamp){
                message.timestamp = timestamp;
                modified = true;
            }
            if(message.type !== type){
                message.type = type;
                modified = true;
            }
            if(message.payload !== payload){
                message.payload = payload;
                modified = true;
            }
            if(modified){
                await this.em().save(message);
            }

            return message;
        }

        return this.em().save(new Message(id, chat, timestamp, type, payload));
    }
}

export enum MessageType {
    Text = "Text",
    Unknown = "Unknown",
    Image = "Image",
    Video = "Video",
    Document = "Document",
    Template = "Template",
    ExtendedText = "ExtendedText",
    Album = "Album",
    Stub = "Stub",
    Contact = "Contact",
    Interactive = "Interactive",
    Location = "Location",
    LiveLocation = "LiveLocation",
}


export {
    Contact, Chat, Message
}