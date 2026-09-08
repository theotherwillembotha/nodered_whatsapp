
import { Node } from "node-red";
import { ConfigNode, ConfigNodeConfig, NodeDescription, NodeManager, SourceUtility } from "@theotherwillembotha/node-red-plugincore";
import { WhatsappAccountConfigNode } from "./WhatsappAccountConfigNode";
import { GroupClient, Subscription, WhatsappSendMessageRequest } from "../service/WhatsappClient";


export interface WhatsappGroupConfigNodeConfig extends ConfigNodeConfig {
    accountConfig:string
    groupId:string
}

@NodeDescription({
    id:"WhatsappGroupConfigNode",
    name:"Whatsapp Group Config Node",
    group:"config",
    sourceFile:SourceUtility.getSourcePath("/build/", "/src/") + "WhatsappGroupConfigNode.html",
    package: "@theotherwillembotha/node-red-whatsapp",
    tags: [ "Whatsapp" ]
})
export class WhatsappGroupConfigNode extends ConfigNode<WhatsappGroupConfigNodeConfig> {
    private accountconfigNode: WhatsappAccountConfigNode;

    public constructor(node: Node, config: WhatsappGroupConfigNodeConfig){
        super(node, config);
        this.accountconfigNode = (NodeManager.RED.nodes.getNode(config.accountConfig) as any).node();
    }

    private getGroup(): GroupClient | undefined {
        return this.accountconfigNode.getGroup(this.config().groupId);
    }

    public send(message: WhatsappSendMessageRequest) {
        const group = this.getGroup();
        if(!group) {
            throw new Error(`WhatsappGroupConfigNode: group client not available — is the account linked and connected?`);
        }
        group.sendMessage(message);
    }

    public subscribe(subscription:Subscription):Subscription {
        const group = this.getGroup();
        if(!group) {
            throw new Error(`WhatsappGroupConfigNode: group client not available — is the account linked and connected?`);
        }
        group.subscribe(subscription);
        return subscription;
    }

    public unsubscribe(subscription:Subscription): void {
        const group = this.getGroup();
        if(!group) return;
        console.log("unsubscribing from", group.id());
        group.unsubscribe(subscription);
    }
}