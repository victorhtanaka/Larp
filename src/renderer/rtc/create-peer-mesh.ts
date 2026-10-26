import type { GroupMember } from '../../shared/cloud-contracts';
import type { SignedChatEnvelope } from '../../shared/webrtc-protocol';
import type { LarpBridge, TurnCredentialServer } from '../../shared/contracts';
import { createBridgeMessageStore } from './bridge-store';
import { createBridgeSignalingTransport } from './bridge-signaling';
import { PeerMesh, type PeerConnectionStatus } from './peer-mesh';

export interface GroupPeerMeshOptions {
  bridge: LarpBridge;
  groupId: string;
  localParticipantId: string;
  members: readonly GroupMember[];
  turnServers?: readonly TurnCredentialServer[];
  onMessage: (message: SignedChatEnvelope) => void;
  onPeerState: (peerId: string, state: PeerConnectionStatus) => void;
  onError: (message: string) => void;
  onTrack?: (peerId: string, track: MediaStreamTrack, streams: readonly MediaStream[]) => void;
}

export function createGroupPeerMesh(options: GroupPeerMeshOptions): PeerMesh {
  const { bridge, groupId, localParticipantId, members, onMessage, onPeerState, onError } = options;
  const memberById = new Map(members.map((member) => [member.userId, member]));
  if (!memberById.has(localParticipantId) || memberById.size > 6) {
    throw new Error('A malha P2P exige a identidade local e até seis membros válidos.');
  }
  const decoder = new TextDecoder();
  const signer = {
    participantId: localParticipantId,
    sign: (bytes: Uint8Array) => bridge.signIdentityPayload(decoder.decode(bytes)),
  };
  const verifier = {
    verify: (participantId: string, bytes: Uint8Array, signature: Parameters<typeof bridge.verifyIdentityPayload>[1], publicKey?: string) => {
      const key = publicKey ?? memberById.get(participantId)?.publicKey;
      if (!key) return Promise.resolve(false);
      return bridge.verifyIdentityPayload(decoder.decode(bytes), signature, key);
    },
  };
  const mesh = new PeerMesh({
    groupId,
    localParticipantId,
    turnServers: options.turnServers,
    signaling: createBridgeSignalingTransport(bridge, groupId, onError),
    signer,
    verifier,
    store: createBridgeMessageStore(bridge),
    isGroupMember: async (requestedGroupId, participantId) => requestedGroupId === groupId && memberById.has(participantId),
    getGroupMemberIds: async (requestedGroupId) => requestedGroupId === groupId ? [...memberById.keys()] : [],
    getMemberPublicKey: async (requestedGroupId, participantId) => requestedGroupId === groupId ? memberById.get(participantId)?.publicKey : undefined,
    callbacks: {
      onOrderedMessage: onMessage,
      onPeerState,
      onTrack: options.onTrack,
      onProtocolError: (_peerId, _code, detail) => onError(detail),
    },
  });
  const remoteIds = [...memberById.keys()].filter((participantId) => participantId !== localParticipantId);
  for (const peerId of remoteIds) {
    void mesh.connect(peerId).catch((error: unknown) => {
      onError(error instanceof Error ? error.message : 'Não foi possível iniciar a conexão P2P.');
    });
  }
  return mesh;
}
