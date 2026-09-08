import { BaseService, ServiceDescription } from "@theotherwillembotha/node-red-plugincore"
import { NodeAPI, NodeAPISettingsWithData } from "node-red";
import { Request, response, Response } from "express";
import { WhatsappClient } from "./WhatsappClient";
import { Role } from "./WhatsappStore";
import fs from "fs";
import QRCode from "qrcode"
import { ParsedQs } from "qs";

@ServiceDescription({
    id: "@theotherwillembotha/whatsappservice",
    name: "WhatsappService",
    type: "integration-plugin",
    sourceFile: "./whatsapp/service/WhatsappService",
})
export class WhatsappService extends BaseService {
    
    private red!: NodeAPI<NodeAPISettingsWithData>;
    private configDir!: string;
    private configFile!: string;
    private connections: Connection[] = []
    private tempClients:{[key:string]:WhatsappClient} = {};       // temp clients are used to keep references to clients while linking accounts.

    // clients is stored in global so that Nodes.js and Plugins.js (which are separate esbuild
    // bundles containing separate copies of this class) share the same runtime map.
    private static readonly _CLIENTS_KEY = '__wa_service_clients__';
    private static clients(): {[key:string]:WhatsappClient} {
        if(!(global as any)[WhatsappService._CLIENTS_KEY]) {
            (global as any)[WhatsappService._CLIENTS_KEY] = {};
        }
        return (global as any)[WhatsappService._CLIENTS_KEY];
    }
    

    constructor(){
        super("WhatsappService");
    }

    public async init(red: NodeAPI<NodeAPISettingsWithData>): Promise<void> {
        this.red = red;
        console.log("STARTING: WhatsappService");

        // whatsapp client commands.
        let writePermission = red.auth.needsPermission("inject.write");
        let readPermission  = red.auth.needsPermission("nodes.read");
        red.httpAdmin.get ("/whatsapp/accounts",        readPermission,  (request, response) => this.getAccounts(request as Request, response as Response));
        red.httpAdmin.post("/whatsapp/linkaccount",     writePermission, (request, response) => this.linkAccount(request as Request<WhatsappLinkAccountRequest>, response as Response));
        red.httpAdmin.post("/whatsapp/unlinkaccount",   writePermission, (request,response) => this.unlinkaccount(request as Request<WhatsappLinkAccountRequest>, response as Response));
        red.httpAdmin.post("/whatsapp/getgroups",       writePermission, (request,response) => this.getGroups(request as Request<WhatsappGetGroupsRequest>, response as Response));
        red.httpAdmin.post("/whatsapp/creategroup",    writePermission, (request,response) => this.createGroup(request as Request<WhatsappCreateGroupRequest>, response as Response));
        red.httpAdmin.post("/whatsapp/groupadduser",    writePermission, (request,response) => this.groupAddUser(request as Request<WhatsappGroupAddUserRequest>, response as Response));
        red.httpAdmin.post("/whatsapp/groupupdateuser", writePermission, (request,response) => this.groupUpdateUser(request as Request<WhatsappGroupUpdateUserRequest>, response as Response));
        red.httpAdmin.post("/whatsapp/groupremoveuser", writePermission, (request,response) => this.groupRemoveUser(request as Request<WhatsappGroupRemoveUserRequest>, response as Response));

        try{
            if(fs.existsSync("/data")){
                console.log("Using /data as storage location");
                this.configDir = "/data/whatsapp";
            }
            else{
                this.configDir = "whatsapp";
            }

            this.configFile = this.configDir + "/connections.json"

            if(!fs.existsSync(this.configDir)){
                fs.mkdirSync(this.configDir);
            }
            if(!fs.existsSync(this.configFile)){
                fs.writeFileSync(this.configFile, JSON.stringify([], null, 2), {flag:"w+"});
            }

            // read the connections file and start the clients.
            this.connections = JSON.parse(fs.readFileSync(this.configFile).toString());
            if(this.connections.length === 0){
                console.log("whatsapp: no connections yet");
            }
            await Promise.all(this.connections.map(connection => {
                let client = new WhatsappClient({
                    localConnectionId:connection.key,
                    fileStorageRoot:this.configDir
                });
                WhatsappService.clients()[connection.key] = client;
                // save account details (name, phone) to connections.json after each reconnect
                client.onConnectionSuccess(() => this.saveConnectionDetails(connection.key));
                return client.start();
            }));
        }
        catch(error){
            console.log(error);
        }
    }

    private saveConnectionDetails(key: string): void {
        try {
            const client = WhatsappService.clients()[key];
            if (!client) return;
            const details = client.details();
            if (!details) return;
            const conn = this.connections.find(c => c.key === key);
            if (conn) {
                conn.name = details.name;
                conn.phoneNumber = details.msisdn;
                fs.writeFileSync(this.configFile, JSON.stringify(this.connections, null, 2), {flag:"w+"});
            }
        } catch(e) {
            console.log("saveConnectionDetails failed", e);
        }
    }

    private getAccounts(request: Request, response: Response): void {
        // collect localConnectionIds claimed by WhatsappAccountConfigNodes in the current flow
        const claimedKeys = new Set<string>();
        this.red.nodes.eachNode((nodeConfig: any) => {
            if (nodeConfig.type === 'WhatsappAccountConfigNode' && nodeConfig.localConnectionId) {
                claimedKeys.add(nodeConfig.localConnectionId);
            }
        });

        const accounts = this.connections.map(connection => ({
            key:         connection.key,
            name:        connection.name,
            phoneNumber: connection.phoneNumber,
            connected:   !!WhatsappService.clients()[connection.key],
            claimed:     claimedKeys.has(connection.key),
        }));

        response.send(accounts);
    }

    public deinit(red: NodeAPI<NodeAPISettingsWithData>): Promise<void> | void {
        console.log("STOPPING: WhatsappService");
    }

    public static getClient(localConnectionId: string): WhatsappClient {
        return WhatsappService.clients()[localConnectionId];
    }

    private linkAccount(request:Request<WhatsappLinkAccountRequest>, response:Response) {
        let linkRequest:WhatsappLinkAccountRequest = request.body;
        console.log("Received request: ", linkRequest);
        let red = this.red;

        // create a whatsapp client.
        let client = new WhatsappClient({
            localConnectionId:linkRequest.localConnectionId,
            fileStorageRoot:this.configDir
        });
        this.tempClients[linkRequest.localConnectionId] = client;

        // start a timer that will only attempt to create a connection for 3min... after that it will close the connection.
        let timeoutTimer = setTimeout(() => {
            console.log("link account request timed out for " + linkRequest.localConnectionId)
            client.stop().then(() => { 
                console.log("connection closed "  + linkRequest.localConnectionId);
                fs.rmSync(this.configDir + "/" +linkRequest.localConnectionId, { recursive:true});
            })
            delete this.tempClients[linkRequest.localConnectionId];

            red.events.emit("runtime-event", {
                id:"whatsapp/" + linkRequest.localConnectionId,
                retain:false,
                payload: {
                    type:"account_link_timeout"
                }
            });
        }, 3*60*1000)

        client.onQRCode((qrcode:string) => {
            QRCode.toString(qrcode, {type:"svg"}, function (error:any, svgImage:any) {
                if (error) {
                    console.log("Error", error);
                    return;
                }
                red.events.emit("runtime-event", {
                    id:"whatsapp/" + linkRequest.localConnectionId,
                    retain:false,
                    payload: {
                        type:"qrcode",
                        qrcode: svgImage
                    }
                });
            });
        });

        client.onConnectionSuccess(() => {
            // make sure we havent got this connection already.
            let knownConnection = this.connections.find(connection => connection.key === linkRequest.localConnectionId);
            if(!knownConnection){
                this.connections.push({ key: linkRequest.localConnectionId });
                // ensure the new entry exists before saveConnectionDetails tries to update it
                fs.writeFileSync(this.configFile, JSON.stringify(this.connections, null, 2), {flag:"w+"});
            }
            // save account details (name, phone) to disk
            this.saveConnectionDetails(linkRequest.localConnectionId);

            // stop the timeout timer, and move client from tempclients to clients.
            clearTimeout(timeoutTimer);
            delete this.tempClients[linkRequest.localConnectionId];
            WhatsappService.clients()[linkRequest.localConnectionId] = client;

            // send a notification to the frontend.
            red.events.emit("runtime-event", {
                id:"whatsapp/" + linkRequest.localConnectionId,
                retain:false,
                payload: {
                    type:"account_linked"
                }
            });
        });

        client.start();
        response.send({status:"ok"});
    }

    private unlinkaccount(request: Request<WhatsappUnlinkAccountRequest>, response:Response):void {
        let unlinkAccountRequest:WhatsappUnlinkAccountRequest = request.body;
        
        // get an instance of the client and stop it.
        let client = WhatsappService.clients()[unlinkAccountRequest.localConnectionId];

        let deleteAccountData = () => {
            // after stopping the client, remove it from the clients list, update the connections file, and remove its storage.
            delete WhatsappService.clients()[unlinkAccountRequest.localConnectionId];
            this.connections = this.connections.filter(connection => connection.key !== unlinkAccountRequest.localConnectionId);
            fs.writeFileSync(this.configFile, JSON.stringify(this.connections, null, 2), {flag:"w+"});
            fs.rmSync(this.configDir + "/" + unlinkAccountRequest.localConnectionId, { recursive:true});
            response.send({status:"ok"});
        }

        if(client){
            client.stop().finally(deleteAccountData);
        }
        else{
            deleteAccountData();
            response.send({result: "ok"})
        }
    }

    private async getGroups(request: Request<WhatsappGetGroupsRequest>, response: Response):Promise<void> {
        let client = WhatsappService.clients()[request.body.localConnectionId];
        if(client){
            response.send(await client.groups().getAll());
        }
        else{
            response.status(500).send({message: "Client not linked"});
        }
    }

    private async createGroup(request: Request<WhatsappCreateGroupRequest>, response: Response):Promise<void> {
        let client = WhatsappService.clients()[request.body.localConnectionId];
        if(client){
            response.send(await client.groups().createGroup(request.body.groupName));
        }
        else{
            response.status(500).send({message: "Client not linked"});
        }
    }

    private async groupAddUser(request: Request<WhatsappGroupAddUserRequest>, response: Response):Promise<void> {
        let client = WhatsappService.clients()[request.body.localConnectionId];
        if(client){
            await client.groups().addUserToGroup(request.body.userId, request.body.groupId, request.body.role as Role);
            response.send({status: "ok"});
        }
        else{
            response.status(500).send({message: "Client not linked"});
        }
    }

    private async groupUpdateUser(request: Request<WhatsappGroupUpdateUserRequest>, response: Response):Promise<void> {
        let client = WhatsappService.clients()[request.body.localConnectionId];
        if(client){
            await client.groups().updateUserRole(request.body.userId, request.body.groupId, request.body.role as Role);
            response.send({status: "ok"});
        }
        else{
            response.status(500).send({message: "Client not linked"});
        }
    }

    private async groupRemoveUser(request: Request<WhatsappGroupRemoveUserRequest>, response: Response):Promise<void> {
        let client = WhatsappService.clients()[request.body.localConnectionId];
        if(client){
            await client.groups().removeUserFromGroup(request.body.userId, request.body.groupId);
            response.send({status: "ok"});
        }
        else{
            response.status(500).send({message: "Client not linked"});
        }
    }

}

type Connection = {
    key: string;
    name?: string;
    phoneNumber?: string;
}

type WhatsappRequest = {
    nodeID:string;
    localConnectionId:string;
}

type WhatsappLinkAccountRequest = WhatsappRequest & {}
type WhatsappUnlinkAccountRequest = WhatsappRequest & {}

type WhatsappGetGroupsRequest = WhatsappRequest & {}
type WhatsappCreateGroupRequest = WhatsappRequest & { groupName: string; }
type WhatsappGroupAddUserRequest = WhatsappRequest & { userId: string; groupId: string; role: string; }
type WhatsappGroupUpdateUserRequest = WhatsappRequest & { userId: string; groupId: string; role: string; }
type WhatsappGroupRemoveUserRequest = WhatsappRequest & { userId: string; groupId: string; }