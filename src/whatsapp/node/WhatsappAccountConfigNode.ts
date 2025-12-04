
import { Node } from "node-red";
import { ConfigNode, ConfigNodeConfig, NodeDescription, SourceUtility } from "@theotherwillembotha/node-red-plugincore";
import { WhatsappService } from "../service/WhatsappService";
import { GroupClient, WhatsappClient } from "../service/WhatsappClient";


export interface WhatsappAccountConfigNodeConfig extends ConfigNodeConfig {
    accountLinked:boolean;
    localConnectionId:string;
}

@NodeDescription({
    id:"WhatsappAccountConfigNode",
    name:"Whatsapp Config Node",
    group:"config",
    sourceFile:SourceUtility.getSourcePath("/build/", "/src/") + "WhatsappAccountConfigNode.html",
    package: "@theotherwillembotha/nodered_whatsapp",
    tags: [ "Whatsapp" ]
})
export class WhatsappAccountConfigNode extends ConfigNode<WhatsappAccountConfigNodeConfig> {
    private client: WhatsappClient;

    constructor(node: Node, config: WhatsappAccountConfigNodeConfig){
        super(node, config);

        // get a reference to the linked Account.
        this.client = WhatsappService.getClient(config.localConnectionId);
    }

    public getGroup(groupId: string): GroupClient | undefined {
        return this.client ? this.client.getGroupClient(groupId) : undefined;
    }
}