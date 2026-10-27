import {
  MAX_ENVELOPE_BYTES,
  MAX_SYNC_BATCH_MESSAGES,
  MAX_SYNC_RANGE,
  WEBRTC_PROTOCOL_VERSION,
  parseProtocolEnvelope,
  signProtocolEnvelope,
  verifyProtocolEnvelope,
  type IdentitySigner,
  type IdentityVerifier,
  type ProtocolErrorCode,
  type SignedAckEnvelope,
  type SignedChatEnvelope,
  type SignedProtocolEnvelope,
  type SignedSyncBatchEnvelope,
} from '../../shared/webrtc-protocol';

const encoder = new TextEncoder();

export type IncomingMessageResult = 'inserted' | 'duplicate' | 'conflict';

export interface LocalMessageStore {
  /** Persist the complete signed envelope atomically before it is sent to any peer. */
  persistBeforeSend(message: SignedChatEnvelope): Promise<void>;
  /** Return conflict for reused message IDs or occupied (group, author, sequence) tuples. */
  persistVerifiedIncoming(message: SignedChatEnvelope): Promise<IncomingMessageResult>;
  /** Return a contiguous signed prefix after `afterSequence`, bounded by `limit` and `throughSequence`. */
  readMissing(
    groupId: string,
    authorId: string,
    afterSequence: number,
    throughSequence: number,
    limit: number,
  ): Promise<readonly SignedChatEnvelope[]>;
  /** Persist idempotently by recipient (`senderId`) only when the ACK matches a locally authored message. */
  persistRecipientAck(acknowledgement: SignedAckEnvelope): Promise<void>;
  /** Return the greatest sequence whose full author-specific prefix is durably present. */
  getHighestContiguousSequence(groupId: string, authorId: string): Promise<number>;
}

export interface MessageSyncCallbacks {
  readonly onMessagePersisted?: (message: SignedChatEnvelope, disposition: IncomingMessageResult | 'outgoing') => void;
  /** Called in sequence order within each individual author's stream. */
  readonly onOrderedMessage?: (message: SignedChatEnvelope) => void;
  readonly onAcknowledgement?: (acknowledgement: SignedAckEnvelope) => void;
  readonly onProtocolError?: (peerId: string, code: ProtocolErrorCode, detail: string) => void;
}

export interface MessageSyncOptions {
  readonly groupId: string;
  readonly localParticipantId: string;
  readonly signer: IdentitySigner;
  readonly verifier: IdentityVerifier;
  readonly store: LocalMessageStore;
  readonly isGroupMember: (groupId: string, participantId: string) => Promise<boolean>;
  readonly getGroupMemberIds: (groupId: string) => Promise<readonly string[]>;
  readonly getMemberPublicKey: (groupId: string, participantId: string) => Promise<string | undefined>;
  readonly getPeerIds: () => readonly string[];
  readonly sendToPeer: (peerId: string, envelope: SignedProtocolEnvelope) => Promise<void>;
  readonly callbacks?: MessageSyncCallbacks;
}

interface PendingRequest {
  readonly peerId: string;
  readonly authorId: string;
  readonly requestId: string;
  readonly afterSequence: number;
  readonly throughSequence: number;
  readonly continueWindow: boolean;
}

interface QueuedMessage {
  readonly message: SignedChatEnvelope;
  readonly notify: boolean;
}

export interface NewChatMessage {
  readonly messageId: string;
  /** Sequence assigned by the local durable store for the local author's stream. */
  readonly sequence: number;
  readonly content: string;
  readonly createdAt?: string;
}

export class MessageSynchronizer {
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly settledThrough = new Map<string, number>();
  private readonly waitingByAuthor = new Map<string, Map<number, QueuedMessage>>();
  private readonly contiguousSequenceByAuthor = new Map<string, number>();
  private readonly highestObservedSequenceByAuthor = new Map<string, number>();

  constructor(private readonly options: MessageSyncOptions) {
    if (options.signer.participantId !== options.localParticipantId) {
      throw new Error('Message signer does not match the local participant.');
    }
  }

  async publish(message: NewChatMessage): Promise<SignedChatEnvelope> {
    const { groupId, localParticipantId, signer, verifier, store } = this.options;
    if (!await this.options.isGroupMember(groupId, localParticipantId)) {
      throw new Error('Local participant is not a member of this group.');
    }
    if (!this.contiguousSequenceByAuthor.has(localParticipantId)) {
      const persistedSequence = await store.getHighestContiguousSequence(groupId, localParticipantId);
      if (!Number.isSafeInteger(persistedSequence) || persistedSequence < 0) {
        throw new Error('Message store returned an invalid local contiguous sequence.');
      }
      this.contiguousSequenceByAuthor.set(localParticipantId, persistedSequence);
      this.highestObservedSequenceByAuthor.set(localParticipantId, persistedSequence);
    }
    if (message.sequence !== (this.contiguousSequenceByAuthor.get(localParticipantId) ?? 0) + 1) {
      throw new Error('Local message sequence must immediately follow the durable author sequence.');
    }
    const envelope = await signProtocolEnvelope({
      version: WEBRTC_PROTOCOL_VERSION,
      kind: 'chat',
      groupId,
      senderId: localParticipantId,
      messageId: message.messageId,
      sequence: message.sequence,
      content: message.content,
      createdAt: message.createdAt ?? new Date().toISOString(),
    }, signer) as SignedChatEnvelope;
    const publicKey = await this.options.getMemberPublicKey(groupId, localParticipantId);
    if (!publicKey || !await verifyProtocolEnvelope(envelope, verifier, publicKey)) {
      throw new Error('The locally signed message failed verification.');
    }
    await store.persistBeforeSend(envelope);
    this.options.callbacks?.onMessagePersisted?.(envelope, 'outgoing');
    this.acceptForOrdering(envelope, true);
    await Promise.all(this.options.getPeerIds().map(async (peerId) => {
      await this.options.sendToPeer(peerId, envelope);
    }));
    return envelope;
  }

  async receive(peerId: string, raw: unknown): Promise<void> {
    if (!await this.options.isGroupMember(this.options.groupId, peerId)) {
      this.options.callbacks?.onProtocolError?.(peerId, 'unauthorized-sender', 'Peer is not a member of this group.');
      return;
    }
    const parsed = parseProtocolEnvelope(raw);
    if (!parsed.ok) {
      await this.reject(peerId, parsed.code, 'Rejected malformed or incompatible protocol data.');
      return;
    }
    const envelope = parsed.envelope;
    if (envelope.kind === 'description' || envelope.kind === 'ice-batch' || envelope.kind === 'connect-request') {
      await this.reject(peerId, 'malformed-envelope', 'Signaling envelope received over the chat channel.');
      return;
    }
    if (envelope.groupId !== this.options.groupId
      || !await this.options.isGroupMember(envelope.groupId, envelope.senderId)) {
      await this.reject(peerId, 'unauthorized-sender', 'Envelope sender or group is not authorized.');
      return;
    }
    const publicKey = await this.options.getMemberPublicKey(envelope.groupId, envelope.senderId);
    if (!publicKey || !await verifyProtocolEnvelope(envelope, this.options.verifier, publicKey)) {
      await this.reject(peerId, 'invalid-signature', 'Envelope signature is invalid.');
      return;
    }

    try {
      switch (envelope.kind) {
        case 'chat':
          await this.receiveChat(peerId, envelope);
          break;
        case 'ack':
          if (envelope.senderId !== peerId) {
            await this.reject(peerId, 'unauthorized-sender', 'Acknowledgement signer does not match the transport peer.');
            return;
          }
          await this.options.store.persistRecipientAck(envelope);
          this.options.callbacks?.onAcknowledgement?.(envelope);
          break;
        case 'sync-request':
          if (envelope.senderId !== peerId) {
            await this.reject(peerId, 'unauthorized-sender', 'Sync requester does not match the transport peer.');
            return;
          }
          await this.respondToSyncRequest(
            peerId,
            envelope.requestId,
            envelope.authorId,
            envelope.afterSequence,
            envelope.throughSequence,
            envelope.limit,
          );
          break;
        case 'sync-batch':
          await this.receiveSyncBatch(peerId, envelope);
          break;
        case 'protocol-error':
          if (envelope.recipientId !== this.options.localParticipantId || envelope.senderId !== peerId) {
            await this.reject(peerId, 'unauthorized-sender', 'Protocol error recipient or sender is invalid.');
            return;
          }
          this.options.callbacks?.onProtocolError?.(peerId, envelope.code, envelope.detail);
          break;
      }
    } catch {
      await this.reject(peerId, 'internal-error', 'Message processing failed.');
    }
  }

  async synchronizePeer(peerId: string): Promise<void> {
    const groupMemberIds = await this.options.getGroupMemberIds(this.options.groupId);
    const authors = new Set([...groupMemberIds, this.options.localParticipantId]);
    await Promise.all([...authors].map(async (authorId) => {
      if (!await this.options.isGroupMember(this.options.groupId, authorId)) return;
      const persistedSequence = await this.options.store.getHighestContiguousSequence(this.options.groupId, authorId);
      if (!Number.isSafeInteger(persistedSequence) || persistedSequence < 0) {
        throw new Error('Message store returned an invalid contiguous sequence.');
      }
      const contiguousSequence = Math.max(this.contiguousSequenceByAuthor.get(authorId) ?? 0, persistedSequence);
      this.contiguousSequenceByAuthor.set(authorId, contiguousSequence);
      this.highestObservedSequenceByAuthor.set(
        authorId,
        Math.max(this.highestObservedSequenceByAuthor.get(authorId) ?? 0, persistedSequence),
      );
      const waiting = this.waitingByAuthor.get(authorId);
      if (waiting) {
        for (const sequence of waiting.keys()) {
          if (sequence <= contiguousSequence) waiting.delete(sequence);
        }
      }
      this.settledThrough.delete(this.scopeKey(peerId, authorId));
      const throughSequence = Math.min(Number.MAX_SAFE_INTEGER, contiguousSequence + MAX_SYNC_RANGE);
      await this.requestMissing(authorId, peerId, throughSequence, true);
    }));
  }

  peerClosed(peerId: string): void {
    for (const [requestId, request] of this.pendingRequests) {
      if (request.peerId === peerId) this.pendingRequests.delete(requestId);
    }
    const prefix = `${peerId}\u0000`;
    for (const key of this.settledThrough.keys()) {
      if (key.startsWith(prefix)) this.settledThrough.delete(key);
    }
  }

  private async receiveChat(
    peerId: string,
    message: SignedChatEnvelope,
    options: { requestMissing?: boolean; notify?: boolean } = {},
  ): Promise<void> {
    if (!this.contiguousSequenceByAuthor.has(message.senderId)) {
      const persistedSequence = await this.options.store.getHighestContiguousSequence(this.options.groupId, message.senderId);
      if (!Number.isSafeInteger(persistedSequence) || persistedSequence < 0) {
        throw new Error('Message store returned an invalid author contiguous sequence.');
      }
      this.contiguousSequenceByAuthor.set(message.senderId, persistedSequence);
      this.highestObservedSequenceByAuthor.set(message.senderId, persistedSequence);
    }
    const result = await this.options.store.persistVerifiedIncoming(message);
    if (result === 'conflict') {
      await this.reject(peerId, 'duplicate-id-conflict', 'A message id or author sequence was reused with different content.');
      return;
    }
    const contiguousSequence = this.contiguousSequenceByAuthor.get(message.senderId) ?? 0;
    if (result === 'inserted') {
      this.options.callbacks?.onMessagePersisted?.(message, result);
      const connectedPeers = this.options.getPeerIds();
      for (const connectedPeerId of connectedPeers) {
        this.settledThrough.delete(this.scopeKey(connectedPeerId, message.senderId));
      }
      await Promise.all(connectedPeers.filter((connectedPeerId) => connectedPeerId !== peerId).map(async (connectedPeerId) => {
        try {
          await this.options.sendToPeer(connectedPeerId, message);
        } catch {
          this.options.callbacks?.onProtocolError?.(
            connectedPeerId,
            'transport-closed',
            'Durable message could not be relayed to this peer.',
          );
        }
      }));
    }
    this.acceptForOrdering(message, (options.notify ?? true) && result === 'inserted');
    if (this.options.getPeerIds().includes(message.senderId)) {
      const acknowledgement = await signProtocolEnvelope({
        version: WEBRTC_PROTOCOL_VERSION,
        kind: 'ack',
        groupId: message.groupId,
        senderId: this.options.localParticipantId,
        messageId: message.messageId,
        sequence: message.sequence,
      }, this.options.signer) as SignedAckEnvelope;
      await this.options.sendToPeer(message.senderId, acknowledgement);
    }
    if (options.requestMissing ?? true) await this.requestMissing(message.senderId);
  }

  private acceptForOrdering(message: SignedChatEnvelope, notify: boolean): void {
    const authorId = message.senderId;
    const contiguousSequence = this.contiguousSequenceByAuthor.get(authorId) ?? 0;
    this.highestObservedSequenceByAuthor.set(
      authorId,
      Math.max(this.highestObservedSequenceByAuthor.get(authorId) ?? 0, message.sequence),
    );
    if (message.sequence > contiguousSequence) {
      let waiting = this.waitingByAuthor.get(authorId);
      if (!waiting) {
        waiting = new Map();
        this.waitingByAuthor.set(authorId, waiting);
      }
      const existing = waiting.get(message.sequence);
      if (existing && existing.message.messageId !== message.messageId) {
        this.options.callbacks?.onProtocolError?.(authorId, 'duplicate-id-conflict', 'Two message ids occupy one author sequence.');
        return;
      }
      waiting.set(message.sequence, { message, notify: notify || existing?.notify === true });
    }
    const waiting = this.waitingByAuthor.get(authorId);
    let nextSequence = contiguousSequence;
    while (waiting?.has(nextSequence + 1)) {
      nextSequence += 1;
      const queued = waiting.get(nextSequence)!;
      waiting.delete(nextSequence);
      if (queued.notify) this.options.callbacks?.onOrderedMessage?.(queued.message);
    }
    this.contiguousSequenceByAuthor.set(authorId, nextSequence);
  }

  private async requestMissing(
    authorId: string,
    peerId?: string,
    targetThrough?: number,
    continueWindow = false,
  ): Promise<void> {
    const afterSequence = this.contiguousSequenceByAuthor.get(authorId) ?? 0;
    const highestObservedSequence = this.highestObservedSequenceByAuthor.get(authorId) ?? 0;
    if (targetThrough === undefined && highestObservedSequence <= afterSequence) return;
    const throughSequence = targetThrough
      ?? Math.min(highestObservedSequence - 1, afterSequence + MAX_SYNC_RANGE);
    const peers = peerId ? [peerId] : this.options.getPeerIds();
    await Promise.all(peers.map(async (participantId) => {
      if (participantId === this.options.localParticipantId) return;
      const scope = this.scopeKey(participantId, authorId);
      const settled = this.settledThrough.get(scope) ?? 0;
      if (targetThrough === undefined && settled >= throughSequence) return;
      if ([...this.pendingRequests.values()].some((request) => request.peerId === participantId && request.authorId === authorId)) return;
      const requestAfter = Math.max(afterSequence, settled);
      const requestThrough = Math.min(throughSequence, requestAfter + MAX_SYNC_RANGE);
      if (requestAfter >= requestThrough) return;
      const requestId = crypto.randomUUID();
      this.pendingRequests.set(requestId, {
        peerId: participantId,
        authorId,
        requestId,
        afterSequence: requestAfter,
        throughSequence: requestThrough,
        continueWindow,
      });
      try {
        const request = await signProtocolEnvelope({
          version: WEBRTC_PROTOCOL_VERSION,
          kind: 'sync-request',
          groupId: this.options.groupId,
          senderId: this.options.localParticipantId,
          authorId,
          requestId,
          afterSequence: requestAfter,
          throughSequence: requestThrough,
          limit: MAX_SYNC_BATCH_MESSAGES,
        }, this.options.signer);
        await this.options.sendToPeer(participantId, request);
      } catch {
        this.pendingRequests.delete(requestId);
      }
    }));
  }

  private async respondToSyncRequest(
    peerId: string,
    requestId: string,
    authorId: string,
    afterSequence: number,
    throughSequence: number,
    limit: number,
  ): Promise<void> {
    if (!await this.options.isGroupMember(this.options.groupId, authorId)) {
      await this.reject(peerId, 'unauthorized-sender', 'Requested message author is not a group member.');
      return;
    }
    const messages = await this.options.store.readMissing(
      this.options.groupId,
      authorId,
      afterSequence,
      throughSequence,
      limit,
    );
    if (messages.length > limit) {
      await this.reject(peerId, 'sync-unavailable', 'Message store exceeded the requested batch limit.');
      return;
    }
    let previousSequence = afterSequence;
    for (const message of messages) {
      if (message.groupId !== this.options.groupId
        || message.senderId !== authorId
        || message.sequence !== previousSequence + 1
        || message.sequence > throughSequence
        || !await this.options.isGroupMember(message.groupId, message.senderId)) {
        await this.reject(peerId, 'sync-unavailable', 'Message store returned a non-member or non-contiguous message.');
        return;
      }
      const publicKey = await this.options.getMemberPublicKey(message.groupId, message.senderId);
      if (!publicKey || !await verifyProtocolEnvelope(message, this.options.verifier, publicKey)) {
        await this.reject(peerId, 'sync-unavailable', 'Message store returned an invalid signature.');
        return;
      }
      previousSequence = message.sequence;
    }
    const boundedMessages: SignedChatEnvelope[] = [];
    const signatureBudget = { algorithm: 'Ed25519', signature: 'A'.repeat(256) } as const;
    for (const message of messages) {
      boundedMessages.push(message);
      const candidate = {
        version: WEBRTC_PROTOCOL_VERSION,
        kind: 'sync-batch',
        groupId: this.options.groupId,
        senderId: this.options.localParticipantId,
        authorId,
        requestId,
        afterSequence,
        throughSequence,
        messages: boundedMessages,
        complete: false,
        signature: signatureBudget,
      };
      if (encoder.encode(JSON.stringify(candidate)).byteLength > MAX_ENVELOPE_BYTES) {
        boundedMessages.pop();
        break;
      }
    }
    if (messages.length > 0 && boundedMessages.length === 0) {
      await this.reject(peerId, 'sync-unavailable', 'A signed message cannot fit in a sync envelope.');
      return;
    }
    const complete = boundedMessages.length === messages.length
      && (messages.length < limit || boundedMessages[boundedMessages.length - 1]?.sequence === throughSequence);
    const batch = await signProtocolEnvelope({
      version: WEBRTC_PROTOCOL_VERSION,
      kind: 'sync-batch',
      groupId: this.options.groupId,
      senderId: this.options.localParticipantId,
      authorId,
      requestId,
      afterSequence,
      throughSequence,
      messages: boundedMessages,
      complete,
    }, this.options.signer) as SignedSyncBatchEnvelope;
    await this.options.sendToPeer(peerId, batch);
  }

  private async receiveSyncBatch(peerId: string, batch: SignedSyncBatchEnvelope): Promise<void> {
    if (batch.senderId !== peerId) {
      await this.reject(peerId, 'unauthorized-sender', 'Sync responder does not match the transport peer.');
      return;
    }
    const pending = this.pendingRequests.get(batch.requestId);
    if (!pending || pending.peerId !== peerId
      || pending.authorId !== batch.authorId
      || pending.afterSequence !== batch.afterSequence
      || pending.throughSequence !== batch.throughSequence) {
      await this.reject(peerId, 'malformed-envelope', 'Sync batch does not match an outstanding request.');
      return;
    }
    for (const message of batch.messages) {
      const publicKey = await this.options.getMemberPublicKey(message.groupId, message.senderId);
      if (!publicKey
        || !await this.options.isGroupMember(message.groupId, message.senderId)
        || !await verifyProtocolEnvelope(message, this.options.verifier, publicKey)) {
        await this.reject(peerId, 'invalid-signature', 'Sync batch contains an unauthenticated message.');
        this.pendingRequests.delete(batch.requestId);
        return;
      }
    }
    try {
      for (const message of batch.messages) await this.receiveChat(peerId, message, { requestMissing: false, notify: false });
    } finally {
      this.pendingRequests.delete(batch.requestId);
    }
    if (batch.complete) {
      const scope = this.scopeKey(peerId, batch.authorId);
      this.settledThrough.set(scope, Math.max(this.settledThrough.get(scope) ?? 0, batch.throughSequence));
      const lastSequence = batch.messages[batch.messages.length - 1]?.sequence;
      if (pending.continueWindow
        && lastSequence === batch.throughSequence
        && batch.throughSequence < Number.MAX_SAFE_INTEGER) {
        const nextThrough = Math.min(Number.MAX_SAFE_INTEGER, batch.throughSequence + MAX_SYNC_RANGE);
        await this.requestMissing(batch.authorId, peerId, nextThrough, true);
      }
    } else {
      const lastSequence = batch.messages[batch.messages.length - 1]?.sequence ?? batch.afterSequence;
      if (lastSequence <= batch.afterSequence || lastSequence >= batch.throughSequence) {
        await this.reject(peerId, 'malformed-envelope', 'Non-final sync batch did not make valid sequence progress.');
        return;
      }
      await this.requestNextBatch(
        peerId,
        batch.authorId,
        lastSequence,
        batch.throughSequence,
        pending.continueWindow,
      );
    }
    await this.requestMissing(batch.authorId);
  }

  private async requestNextBatch(
    peerId: string,
    authorId: string,
    afterSequence: number,
    throughSequence: number,
    continueWindow: boolean,
  ): Promise<void> {
    if (!this.options.getPeerIds().includes(peerId)) return;
    const requestId = crypto.randomUUID();
    const request: PendingRequest = {
      peerId,
      authorId,
      requestId,
      afterSequence,
      throughSequence,
      continueWindow,
    };
    this.pendingRequests.set(requestId, request);
    try {
      const envelope = await signProtocolEnvelope({
        version: WEBRTC_PROTOCOL_VERSION,
        kind: 'sync-request',
        groupId: this.options.groupId,
        senderId: this.options.localParticipantId,
        authorId,
        requestId,
        afterSequence,
        throughSequence,
        limit: MAX_SYNC_BATCH_MESSAGES,
      }, this.options.signer);
      await this.options.sendToPeer(peerId, envelope);
    } catch {
      this.pendingRequests.delete(requestId);
    }
  }

  private scopeKey(peerId: string, authorId: string): string {
    return `${peerId}\u0000${authorId}`;
  }

  private async reject(peerId: string, code: ProtocolErrorCode, detail: string): Promise<void> {
    this.options.callbacks?.onProtocolError?.(peerId, code, detail);
    if (!this.options.getPeerIds().includes(peerId)) return;
    try {
      const error = await signProtocolEnvelope({
        version: WEBRTC_PROTOCOL_VERSION,
        kind: 'protocol-error',
        groupId: this.options.groupId,
        senderId: this.options.localParticipantId,
        recipientId: peerId,
        code,
        detail,
      }, this.options.signer);
      await this.options.sendToPeer(peerId, error);
    } catch {
      // A protocol failure must not trigger a second error response.
    }
  }
}
