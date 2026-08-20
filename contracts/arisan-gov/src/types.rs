use soroban_sdk::{contracterror, contracttype, Address};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalKind {
    Skip(Address),
    Kick(Address),
}

impl ProposalKind {
    pub fn subject(&self) -> Address {
        match self {
            ProposalKind::Skip(a) => a.clone(),
            ProposalKind::Kick(a) => a.clone(),
        }
    }
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    pub id: u32,
    pub kind: ProposalKind,
    pub proposer: Address,
    pub deadline: u64,
    pub yes_votes: u32,
    pub no_votes: u32,
    pub executed: bool,
    /// Yes-votes needed to execute, snapshotted from the electorate as it
    /// stood at `propose` time. `execute` enforces
    /// `max(required_yes, <live recomputation>)`; the live term is kept as
    /// defense-in-depth against a prior pre-activation exploit, but since
    /// `propose` is gated on `pool.activated`, the electorate is already
    /// maximal at snapshot time, so in practice `required_yes` is the
    /// binding value — the live recomputation can only match it or fall
    /// below it (post-activation, membership only shrinks) and never rise
    /// above it. See the comment on `ArisanGov::execute` for the full
    /// history.
    pub required_yes: u32,
    /// For Kick proposals: the subject's `received_payout` status AS OF PROPOSE
    /// TIME. `execute` re-checks this against the CURRENT value before acting —
    /// if it has changed, the proposal is stale (it would kick under different
    /// terms than what was voted on) and execution is refused permanently.
    /// Irrelevant for Skip proposals (always `false`, unused).
    pub payout_snapshot: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Pool,
    VotingWindow,
    NextId,
    Proposal(u32),
    Voted(u32, Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotAMember = 1,
    SubjectNotAMember = 2,
    SubjectCannotVote = 3,
    AlreadyVoted = 4,
    ProposalNotFound = 5,
    VotingClosed = 6,
    AlreadyExecuted = 7,
    ThresholdNotMet = 8,
    NoVotesCast = 9,
    PoolNotActivated = 10,
    PoolClosed = 11,
    ElectorateTooSmall = 12,
    SubjectStateChanged = 13,
}
