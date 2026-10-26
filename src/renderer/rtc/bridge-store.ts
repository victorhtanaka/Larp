import type { LarpBridge } from '../../shared/contracts';
import type { LocalMessageStore } from './message-sync';

export function createBridgeMessageStore(bridge: LarpBridge): LocalMessageStore {
  return {
    persistBeforeSend: (message) => bridge.persistOutgoingEnvelope(message),
    persistVerifiedIncoming: (message) => bridge.persistVerifiedEnvelope(message),
    readMissing: (groupId, authorId, afterSequence, throughSequence, limit) =>
      bridge.readMissingEnvelopes(groupId, authorId, afterSequence, throughSequence, limit),
    persistRecipientAck: (acknowledgement) => bridge.persistMessageAcknowledgement(acknowledgement),
    getHighestContiguousSequence: (groupId, authorId) => bridge.getHighestContiguousSequence(groupId, authorId),
  };
}
