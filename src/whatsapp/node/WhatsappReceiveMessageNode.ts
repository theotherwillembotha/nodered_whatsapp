import { Node } from "node-red";
import { BaseNode, BaseNodeConfig, NodeDescription, NodeManager, SourceUtility } from "@theotherwillembotha/node-red-plugincore";
import { Metrics, MetricType, MetricsTemplate, CounterMetric, MetricsTemplateConfig } from "@theotherwillembotha/node-red-plugincore";
import { Log, Logger, LoggerTemplate, LoggerTemplateConfig } from "@theotherwillembotha/node-red-plugincore";
import { WhatsappGroupConfigNode } from "./WhatsappGroupConfigNode";
import { Subscription, WhatsappMessage } from "../service/WhatsappClient";

interface AcceptEntry {
    id: string;
    enabled: boolean;
}

export interface WhatsappReceiveMessageNodeConfig extends BaseNodeConfig, MetricsTemplateConfig, LoggerTemplateConfig {
    groupConfig: string;
    eventOutputKey: string;
    eventOutputType: string;
    acceptOwnMessages: boolean;
    accepts: string;
}

@NodeDescription({
    id:"WhatsappReceiveMessageNode",
    name:"Whatsapp Receive Message Node",
    group:"whatsapp",
    sourceFile:SourceUtility.getSourcePath("/build/", "/src/") + "WhatsappReceiveMessageNode.html",
    package: "@theotherwillembotha/node-red-whatsapp",
    templates: [
        {template: LoggerTemplate, config: {}},
        {template: MetricsTemplate, config: {}},
    ],
    tags: [ "Whatsapp" ]
})
export class WhatsappReceiveMessageNode extends BaseNode<WhatsappReceiveMessageNodeConfig> {

    @Logger()
    private log!:Log;

    @Metrics({name:"counter",type:MetricType.Counter, description:"number of messages received"})
    private counter!:CounterMetric;

    private groupNode: WhatsappGroupConfigNode;
    private subscription: Subscription;

    constructor(node: Node, config: WhatsappReceiveMessageNodeConfig){
        super(node, config);

        let accepts: AcceptEntry[] = [];
        try { accepts = JSON.parse(config.accepts || "[]"); } catch(e) {}
        const enabledTypes = new Set(accepts.filter(a => a.enabled).map(a => a.id));

        this.groupNode = (NodeManager.RED.nodes.getNode(config.groupConfig) as any).node();

        this.subscription = this.groupNode.subscribe((message: WhatsappMessage) => {
            if(enabledTypes.size > 0 && !enabledTypes.has(message.type)) return;
            if(!config.acceptOwnMessages && message.sender?.me) return;

            this.log.log(message);
            this.counter.inc();

            const output: any = {};
            if(config.eventOutputType === 'flow') {
                this.node().context().flow.set(config.eventOutputKey, message);
            } else if(config.eventOutputType === 'global') {
                this.node().context().global.set(config.eventOutputKey, message);
            } else {
                this.setPath(output, config.eventOutputKey, message);
            }
            this.node().send(output);
        });

        this.node().on("close", () => this.groupNode.unsubscribe(this.subscription));
    }

    private setPath(obj: any, path: string, value: any): void {
        const parts = path.split('.');
        let cur = obj;
        for(let i = 0; i < parts.length - 1; i++) {
            if(typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) {
                cur[parts[i]] = {};
            }
            cur = cur[parts[i]];
        }
        cur[parts[parts.length - 1]] = value;
    }
}
