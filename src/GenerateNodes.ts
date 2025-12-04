import { NodeGenerator } from "@theotherwillembotha/node-red-plugincore"

// services.
import { WhatsappService } from "./whatsapp/service/WhatsappService";


// nodes.
import { WhatsappAccountConfigNode } from "./whatsapp/node/WhatsappAccountConfigNode";
import { WhatsappGroupConfigNode } from "./whatsapp/node/WhatsappGroupConfigNode";
import { WhatsappSendMessageNode } from "./whatsapp/node/WhatsappSendMessageNode";
import { WhatsappReceiveMessageNode } from "./whatsapp/node/WhatsappReceiveMessageNode";

new NodeGenerator("./src/")
    // services.
    .registerService(WhatsappService)

    // nodes
    .registerNode(WhatsappAccountConfigNode)
    .registerNode(WhatsappGroupConfigNode)
    .registerNode(WhatsappSendMessageNode)
    .registerNode(WhatsappReceiveMessageNode)

    // done.
    .generate("./build/Nodes", "./build/Plugins");

process.exit(0);