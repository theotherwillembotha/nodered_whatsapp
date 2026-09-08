import { NodeGenerator } from "@theotherwillembotha/node-red-plugincore";
import { LoggerService, MetricsService, NodeTypeService, SettingsService } from "@theotherwillembotha/node-red-plugincore";
import { DelegatedConfigReferenceNode, ConsoleLoggerConfigNode, RestLoggerConfigNode } from "@theotherwillembotha/node-red-plugincore";
import { CounterMetricConfigNode, GaugeMetricConfigNode, TimerMetricConfigNode } from "@theotherwillembotha/node-red-plugincore";

// services.
import { WhatsappService } from "./whatsapp/service/WhatsappService";

// nodes.
import { WhatsappAccountConfigNode } from "./whatsapp/node/WhatsappAccountConfigNode";
import { WhatsappGroupConfigNode } from "./whatsapp/node/WhatsappGroupConfigNode";
import { WhatsappSendMessageNode } from "./whatsapp/node/WhatsappSendMessageNode";
import { WhatsappDynamicSendMessageNode } from "./whatsapp/node/WhatsappDynamicSendMessageNode";
import { WhatsappReceiveMessageNode } from "./whatsapp/node/WhatsappReceiveMessageNode";

new NodeGenerator("./src/whatsapp/")
    // infrastructure services (deduplication guards prevent double-registration)
    .registerService(LoggerService)
    .registerService(MetricsService)
    .registerService(NodeTypeService)
    .registerService(SettingsService)

    // infrastructure nodes
    .registerNode(DelegatedConfigReferenceNode)
    .registerNode(ConsoleLoggerConfigNode)
    .registerNode(RestLoggerConfigNode)
    .registerNode(CounterMetricConfigNode)
    .registerNode(GaugeMetricConfigNode)
    .registerNode(TimerMetricConfigNode)

    // whatsapp service
    .registerService(WhatsappService)

    // whatsapp nodes
    .registerNode(WhatsappAccountConfigNode)
    .registerNode(WhatsappGroupConfigNode)
    .registerNode(WhatsappSendMessageNode)
    .registerNode(WhatsappDynamicSendMessageNode)
    .registerNode(WhatsappReceiveMessageNode)

    .generate("./build/Nodes", "./build/Plugins");

process.exit(0);