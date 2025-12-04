import { Node } from "node-red";
import { BaseNode, BaseNodeConfig, Message, NodeDescription, NodeManager, onInput, SourceUtility } from "@theotherwillembotha/node-red-plugincore";
import { Metrics, MetricType, MetricsTemplate, CounterMetric, MetricsTemplateConfig } from "@theotherwillembotha/node-red-plugincore";
import { Log, Logger, LoggerTemplate, LoggerTemplateConfig } from "@theotherwillembotha/node-red-plugincore";
import { WhatsappGroupConfigNode } from "./WhatsappGroupConfigNode";
import { WhatsappSendMessageRequest } from "../service/WhatsappClient";
import Handlebars from "handlebars";

type PayloadConfig = {
    id: string;
    enabled: boolean;
    type: string;
    value: string;
}

export interface WhatsappSendMessageNodeConfig extends BaseNodeConfig, MetricsTemplateConfig, LoggerTemplateConfig {
    groupConfig: string;
    payloads: string;   // JSON-serialised PayloadConfig[]
}

@NodeDescription({
    id:"WhatsappSendMessageNode",
    name:"Whatsapp Send Message Node",
    group:"whatsapp",
    sourceFile:SourceUtility.getSourcePath("/build/", "/src/") + "WhatsappSendMessageNode.html",
    package: "@theotherwillembotha/nodered_whatsapp",
    templates: [
        {template: LoggerTemplate, config: {}},
        {template: MetricsTemplate, config: {}},
    ],
    tags: [ "Whatsapp" ]
})
export class WhatsappSendMessageNode extends BaseNode<WhatsappSendMessageNodeConfig> {

    @Logger()
    private log!: Log;

    @Metrics({name:"counter", type:MetricType.Counter, description:"number of messages sent"})
    private counter!: CounterMetric;

    private groupNode: WhatsappGroupConfigNode;

    constructor(node: Node, config: WhatsappSendMessageNodeConfig){
        super(node, config);
        this.groupNode = (NodeManager.RED.nodes.getNode(config.groupConfig) as any).node();
    }

    private resolveValue(field: PayloadConfig, message: Message): any {
        switch(field.type) {
            case "str":
                return Handlebars.compile(field.value)({ msg: message });
            case "msg":
                return field.value.split(".").reduce((obj: any, key) => obj?.[key], message);
            case "flow":
                return (this.node() as any).context().flow.get(field.value);
            case "global":
                return (this.node() as any).context().global.get(field.value);
            default:
                return undefined;
        }
    }

    @onInput()
    protected onMessageReceived(message: Message): void {
        this.counter.inc();

        let fields: PayloadConfig[] = [];
        try { fields = JSON.parse(this.config().payloads || "[]"); } catch(e) {}

        let payload: WhatsappSendMessageRequest = {};
        for(let field of fields) {
            if(!field.enabled) continue;
            let resolved = this.resolveValue(field, message);
            if(field.id === "text")  payload.text  = resolved != null ? String(resolved) : undefined;
            if(field.id === "image") payload.image = resolved;
        }

        let logPayload: {[key:string]:any} = {};
        if(payload.text)  logPayload.text  = payload.text;
        if(payload.image) logPayload.image = (payload.image as Buffer)?.length;
        this.log.log(logPayload);

        console.log(payload);

        this.groupNode.send(payload);
    }
}
