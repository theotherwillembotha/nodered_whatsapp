import { Node } from "node-red";
import { BaseNode, BaseNodeConfig, Message, NodeDescription, NodeManager, onInput, SourceUtility } from "@theotherwillembotha/node-red-plugincore";
import { Metrics, MetricType, MetricsTemplate, CounterMetric, MetricsTemplateConfig } from "@theotherwillembotha/node-red-plugincore";
import { Log, Logger, LoggerTemplate, LoggerTemplateConfig } from "@theotherwillembotha/node-red-plugincore";
import { WhatsappAccountConfigNode } from "./WhatsappAccountConfigNode";
import { WhatsappSendMessageRequest } from "../service/WhatsappClient";
import Handlebars from "handlebars";

type SendAction = {
    type: "text" | "image" | "video" | "document";
    value: string;
    valueType: string;
    documentName?: string;
    documentNameType?: string;
    documentMimetype?: string;
    documentMimetypeType?: string;
}

export interface WhatsappDynamicSendMessageNodeConfig extends BaseNodeConfig, MetricsTemplateConfig, LoggerTemplateConfig {
    accountConfig: string;
    recipient: string;
    recipientType: string;
    payloads: string;   // JSON-serialised SendAction[]
}

@NodeDescription({
    id:"WhatsappDynamicSendMessageNode",
    name:"Whatsapp Dynamic Send Message Node",
    group:"whatsapp",
    sourceFile:SourceUtility.getSourcePath("/build/", "/src/") + "WhatsappDynamicSendMessageNode.html",
    package: "@theotherwillembotha/node-red-whatsapp",
    templates: [
        {template: LoggerTemplate, config: {}},
        {template: MetricsTemplate, config: {}},
    ],
    tags: [ "Whatsapp" ]
})
export class WhatsappDynamicSendMessageNode extends BaseNode<WhatsappDynamicSendMessageNodeConfig> {

    @Logger()
    private log!: Log;

    @Metrics({name:"counter", type:MetricType.Counter, description:"number of messages sent"})
    private counter!: CounterMetric;

    private accountNode: WhatsappAccountConfigNode;

    constructor(node: Node, config: WhatsappDynamicSendMessageNodeConfig){
        super(node, config);
        this.accountNode = (NodeManager.RED.nodes.getNode(config.accountConfig) as any).node();
    }

    private resolveField(value: string, valueType: string, message: Message): any {
        switch(valueType) {
            case "str":    return Handlebars.compile(value)({ msg: message });
            case "msg":    return value.split(".").reduce((obj: any, key: string) => obj?.[key], message);
            case "flow":   return (this.node() as any).context().flow.get(value);
            case "global": return (this.node() as any).context().global.get(value);
            default:       return undefined;
        }
    }

    @onInput()
    protected async onMessageReceived(message: Message): Promise<void> {
        this.counter.inc();

        const chatId = this.resolveField(this.config().recipient, this.config().recipientType, message);
        if(!chatId) {
            this.log.log({ error: "recipient resolved to empty value — message not sent" });
            return;
        }

        let actions: SendAction[] = [];
        try { actions = JSON.parse(this.config().payloads || "[]"); } catch(e) {}

        for(const action of actions) {
            const resolved = this.resolveField(action.value, action.valueType, message);
            let payload: WhatsappSendMessageRequest = {};

            switch(action.type) {
                case "text":
                    payload.text = resolved != null ? String(resolved) : undefined;
                    break;
                case "image":
                    payload.image = resolved;
                    break;
                case "video":
                    payload.video = resolved;
                    break;
                case "document":
                    payload.document = resolved;
                    if(action.documentName) {
                        payload.documentName = String(this.resolveField(action.documentName, action.documentNameType ?? "str", message) ?? "");
                    }
                    if(action.documentMimetype) {
                        payload.documentMimetype = String(this.resolveField(action.documentMimetype, action.documentMimetypeType ?? "str", message) ?? "");
                    }
                    break;
            }

            let logPayload: {[key:string]:any} = { chatId: String(chatId) };
            if(payload.text)     logPayload.text     = payload.text;
            if(payload.image)    logPayload.image    = (payload.image as Buffer)?.length;
            if(payload.video)    logPayload.video    = (payload.video as Buffer)?.length;
            if(payload.document) logPayload.document = (payload.document as Buffer)?.length;
            this.log.log(logPayload);

            await this.accountNode.sendMessage(String(chatId), payload);
        }
    }
}
