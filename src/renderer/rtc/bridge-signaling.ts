import type { LarpBridge } from '../../shared/contracts';
import type { SignedProtocolEnvelope } from '../../shared/webrtc-protocol';
import type { SignalingTransport } from './peer-mesh';

export function createBridgeSignalingTransport(
  bridge: LarpBridge,
  groupId: string,
  onError: (message: string) => void,
): SignalingTransport {
  return {
    send: async (peerId, envelope) => {
      if (!('recipientId' in envelope) || envelope.recipientId !== peerId) {
        throw new Error('Sinalização direta exige o destinatário correspondente ao par.');
      }
      await bridge.sendSignal(groupId, envelope as SignedProtocolEnvelope);
    },
    subscribe: (listener) => bridge.subscribeSignals(groupId, listener, onError),
  };
}
