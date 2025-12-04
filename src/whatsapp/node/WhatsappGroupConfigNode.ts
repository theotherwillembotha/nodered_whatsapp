
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
    package: "@theotherwillembotha/nodered_whatsapp",
    tags: [ "Whatsapp" ]
})
export class WhatsappGroupConfigNode extends ConfigNode<WhatsappGroupConfigNodeConfig> {
    private accountconfigNode: WhatsappAccountConfigNode;
    private group:GroupClient;

    public constructor(node: Node, config: WhatsappGroupConfigNodeConfig){
        super(node, config);

        this.accountconfigNode = (NodeManager.RED.nodes.getNode(config.accountConfig) as any).node();
        this.group = this.accountconfigNode.getGroup(config.groupId)!;
    }

    public send(message: WhatsappSendMessageRequest) {
        console.log("Sending message to ", this.group.id());
        this.group.sendMessage(message);
    }

    public subscribe(subscription:Subscription):Subscription {
        this.group.subscribe(subscription);
        return subscription;
    }

    public unsubscribe(subscription:Subscription): void {
        console.log("unsubscribing from", this.group.id());
        this.group.unsubscribe(subscription);
        return;
    }
}