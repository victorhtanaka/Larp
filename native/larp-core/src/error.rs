
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreError {
    InvalidRequest,
    UnsupportedVersion,
    InputTooLarge,
    InvalidIdentity,
    InvalidEnvelope,
    InvalidSequence,
    InvalidRange,
    InvalidCache,
    Conflict,
    Storage,
    Closed,
    Backpressure,
    CloudConfiguration,
    CloudAuthentication,
    CloudTransport,
    CloudResponse,
    InvalidCloudData,
    InvalidProfile,
    InvalidTurnCredentials,
    Internal,
}

impl CoreError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid-request",
            Self::UnsupportedVersion => "unsupported-version",
            Self::InputTooLarge => "input-too-large",
            Self::InvalidIdentity => "invalid-identity",
            Self::InvalidEnvelope => "invalid-envelope",
            Self::InvalidSequence => "invalid-sequence",
            Self::InvalidRange => "invalid-range",
            Self::InvalidCache => "invalid-cache",
            Self::Conflict => "conflict",
            Self::Storage => "storage-failed",
            Self::Closed => "stale-context",
            Self::Backpressure => "queue-full",
            Self::CloudConfiguration => "cloud-configuration",
            Self::CloudAuthentication => "cloud-authentication",
            Self::CloudTransport => "cloud-unavailable",
            Self::CloudResponse => "cloud-response-invalid",
            Self::InvalidCloudData => "cloud-data-invalid",
            Self::InvalidProfile => "invalid-profile",
            Self::InvalidTurnCredentials => "invalid-turn-credentials",
            Self::Internal => "internal-error",
        }
    }

    pub const fn message(self) -> &'static str {
        match self {
            Self::InvalidRequest => "The native request is malformed.",
            Self::UnsupportedVersion => "The native request version is unsupported.",
            Self::InputTooLarge => "The native request exceeds the permitted size.",
            Self::InvalidIdentity => "The identity operation failed validation.",
            Self::InvalidEnvelope => "The signed protocol envelope is invalid.",
            Self::InvalidSequence => "The message sequence is invalid.",
            Self::InvalidRange => "The message range is invalid.",
            Self::InvalidCache => "The cloud cache data is invalid.",
            Self::Conflict => "The message identifier or author sequence is already occupied.",
            Self::Storage => "The local storage operation failed.",
            Self::Closed => "The native core is closed.",
            Self::Backpressure => "The native operation queue is full.",
            Self::CloudConfiguration => "The cloud configuration is invalid.",
            Self::CloudAuthentication => "Cloud authentication is unavailable.",
            Self::CloudTransport => "The cloud service is unavailable.",
            Self::CloudResponse => "The cloud service returned an invalid response.",
            Self::InvalidCloudData => "The cloud data failed validation.",
            Self::InvalidProfile => "The profile data is invalid.",
            Self::InvalidTurnCredentials => "The managed TURN credentials are invalid.",
            Self::Internal => "The native operation failed.",
        }
    }
}

