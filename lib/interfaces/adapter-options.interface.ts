import {
  CreateSubscriptionOptions,
  CreateTopicOptions,
  ServiceBusReceiverOptions,
  SubscribeOptions,
} from "@azure/service-bus";
import { ClusterAdapterOptions } from "socket.io-adapter";

export interface AdapterOptions extends ClusterAdapterOptions {
  /**
   * The name of the topic.
   * @default "socket.io"
   */
  topicName?: string;
  /**
   * The options used to create the topic.
   */
  topicOptions?: CreateTopicOptions;
  /**
   * The prefix of the subscription (one subscription will be created per Socket.IO server in the cluster).
   * @default "socket.io"
   */
  subscriptionPrefix?: string;
  /**
   * The options used to create the subscription.
   */
  subscriptionOptions?: CreateSubscriptionOptions;
  /**
   * The options used to create the receiver.
   */
  receiverOptions?: ServiceBusReceiverOptions;

  /**
   * The options used to subscribe to the topic: Ex: { maxConcurrentCalls: 1 }
   */
  subscribeOptions?: SubscribeOptions;

  /**
   *  subscriptionName: string; The name of the subscription.
   * @default  uuid
   */
  subscriptionName?: string;
}
