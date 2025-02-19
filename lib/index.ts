import { ClusterAdapterWithHeartbeat } from "socket.io-adapter";
import type {
  ClusterAdapterOptions,
  ClusterMessage,
  ClusterResponse,
  Offset,
  ServerId,
} from "socket.io-adapter";
import { encode, decode } from "@msgpack/msgpack";
import { randomBytes } from "node:crypto";
import type {
  ProcessErrorArgs,
  ServiceBusAdministrationClient,
  ServiceBusClient,
  ServiceBusMessage,
  ServiceBusReceivedMessage,
  ServiceBusSender,
} from "@azure/service-bus";
import { AdapterOptions } from "./interfaces/adapter-options.interface";
import { Logger } from "./interfaces/logger.interface";

// const debug = require("debug")("socket.io-azure-service-bus-adapter");

function randomId() {
  return randomBytes(8).toString("hex");
}

async function createSubscription(
  adminClient: ServiceBusAdministrationClient,
  topicName: string,
  subscriptionName: string,
  opts: AdapterOptions,
  logger: Logger
) {
  try {
    await adminClient.getTopic(topicName);

    logger.warn(`topic ${topicName} already exists`);
  } catch (e) {
    logger.error(`topic ${topicName} does not exist`);
    await adminClient.createTopic(topicName, opts.topicOptions);
    logger.warn(`topic ${topicName} was successfully created`);
  }

  logger.debug(`creating subscription ${subscriptionName}`);

  try {
    await adminClient.getSubscription(topicName, subscriptionName);
    logger.warn(`subscription ${subscriptionName} already exists`);
  } catch (e) {
    logger.warn(`subscription ${subscriptionName} does not exist`);
    await adminClient.createSubscription(
      topicName,
      subscriptionName,
      opts.subscriptionOptions
    );
    logger.warn(`subscription ${subscriptionName} was successfully created`);
  }

  return {
    topicName,
    subscriptionName,
  };
}

/**
 * Returns a function that will create a {@link PubSubAdapter} instance.
 *
 * @param client - a ServiceBusClient instance from the `@azure/service-bus` package
 * @param adminClient - a ServiceBusAdministrationClient instance from the `@azure/service-bus` package
 * @param opts - additional options
 *
 * @see https://learn.microsoft.com/en-us/azure/service-bus-messaging
 *
 * @public
 */
export function createAdapter(
  client: ServiceBusClient,
  adminClient: ServiceBusAdministrationClient,
  opts: AdapterOptions = {},
  logger: Logger = {
    debug: () => {},
    error: console.error,
    warn: console.warn,
  }
) {
  const namespaceToAdapters = new Map<string, PubSubAdapter>();

  const topicName = opts.topicName || "socket.io";
  // subscriptionName can't be longer than 50 characters
  const subscriptionName = `${opts.subscriptionPrefix || "socket.io"}-${
    opts.subscriptionName || randomId()
  }`.substring(0, 50);

  const sender = client.createSender(topicName);
  const receiver = client.createReceiver(
    topicName,
    subscriptionName,
    opts.receiverOptions
  );

  const subscriptionCreation = createSubscription(
    adminClient,
    topicName,
    subscriptionName,
    opts,
    logger
  )
    .then(() => {
      receiver.subscribe(
        {
          async processMessage(
            message: ServiceBusReceivedMessage
          ): Promise<void> {
            if (
              !message.applicationProperties ||
              typeof message.applicationProperties["nsp"] !== "string"
            ) {
              logger.warn("ignore malformed message");
              return;
            }
            const namespace = message.applicationProperties["nsp"];

            namespaceToAdapters.get(namespace)?.onRawMessage(message);

            if (receiver.receiveMode === "peekLock") {
              await receiver.completeMessage(message);
            }
          },
          async processError(args: ProcessErrorArgs): Promise<void> {
            logger.error(`an error has occurred: ${args.error.message}`);
          },
        },
        opts?.subscribeOptions
      );
    })
    .catch((err) => {
      logger.error(
        `an error has occurred while creating the subscription: ${err.message}`
      );
    });

  const fn: (nsp: any) => PubSubAdapter = function (nsp: any) {
    const adapter = new PubSubAdapter(nsp, sender, opts);

    namespaceToAdapters.set(nsp.name, adapter);

    const defaultInit = adapter.init;

    adapter.init = () => {
      return subscriptionCreation.then(() => {
        defaultInit.call(adapter);
      });
    };

    const defaultClose = adapter.close;

    adapter.close = async () => {
      defaultClose.call(adapter);

      namespaceToAdapters.delete(nsp.name);

      if (namespaceToAdapters.size === 0) {
        logger.warn(`deleting subscription ${subscriptionName}`);

        return Promise.all([
          receiver.close(),
          sender.close(),
          adminClient
            .deleteSubscription(topicName, subscriptionName)
            .then(() => {
              logger.warn(
                `subscription ${subscriptionName} was successfully deleted`
              );
            })
            .catch((err) => {
              logger.error(
                `an error has occurred while deleting the subscription: ${err.message}`
              );
            }),
        ]);
      }
    };

    return adapter;
  };
  return {
    adapter: fn,
    subscriptionName: subscriptionName,
  };
}

export class PubSubAdapter extends ClusterAdapterWithHeartbeat {
  private readonly sender: ServiceBusSender;
  /**
   * Adapter constructor.
   *
   * @param nsp - the namespace
   * @param sender - a ServiceBus sender
   * @param opts - additional options
   *
   * @public
   */
  constructor(nsp: any, sender: ServiceBusSender, opts: ClusterAdapterOptions) {
    super(nsp, opts);
    this.sender = sender;
  }

  protected doPublish(message: ClusterMessage): Promise<Offset> {
    return this.sender
      .sendMessages({
        body: encode(message),
        applicationProperties: {
          nsp: this.nsp.name,
          uid: this.uid,
        },
      })
      .then();
  }

  protected doPublishResponse(
    requesterUid: ServerId,
    response: ClusterResponse
  ): Promise<void> {
    return this.sender
      .sendMessages({
        body: encode(response),
        applicationProperties: {
          nsp: this.nsp.name,
          uid: this.uid,
          requesterUid,
        },
      })
      .then();
  }

  public onRawMessage(rawMessage: ServiceBusMessage) {
    if (rawMessage.applicationProperties!["uid"] === this.uid) {
      // debug("ignore message from self");
      return;
    }

    const requesterUid = rawMessage.applicationProperties!["requesterUid"];
    if (requesterUid && requesterUid !== this.uid) {
      // debug("ignore response for another node");
      return;
    }

    const decoded = decode(rawMessage.body);
    // debug("received %j", decoded);

    if (requesterUid) {
      this.onResponse(decoded as ClusterResponse);
    } else {
      this.onMessage(decoded as ClusterMessage);
    }
  }
}
