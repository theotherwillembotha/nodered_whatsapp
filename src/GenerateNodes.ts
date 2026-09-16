import { NodeGenerator, NodeTypeService } from "@theotherwillembotha/node-red-plugincore";

import { WhatsappService } from "./whatsapp/service/WhatsappService";
import { WhatsappAccountConfigNode } from "./whatsapp/node/WhatsappAccountConfigNode";
import { WhatsappGroupConfigNode } from "./whatsapp/node/WhatsappGroupConfigNode";
import { WhatsappSendMessageNode } from "./whatsapp/node/WhatsappSendMessageNode";
import { WhatsappDynamicSendMessageNode } from "./whatsapp/node/WhatsappDynamicSendMessageNode";
import { WhatsappReceiveMessageNode } from "./whatsapp/node/WhatsappReceiveMessageNode";

new NodeGenerator("./src/whatsapp/")
    .registerService(NodeTypeService)
    .registerService(WhatsappService)
    .registerNode(WhatsappAccountConfigNode)
    .registerNode(WhatsappGroupConfigNode)
    .registerNode(WhatsappSendMessageNode)
    .registerNode(WhatsappDynamicSendMessageNode)
    .registerNode(WhatsappReceiveMessageNode)
    .generate("./build/Nodes", "./build/Plugins", "@theotherwillembotha/node-red-whatsapp");

process.exit(0);