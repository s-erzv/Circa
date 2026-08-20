use soroban_sdk::{contractevent, Address};

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Contributed {
    #[topic]
    pub member: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Distributed {
    #[topic]
    pub recipient: Address,
    pub net_payout: i128,
    pub drawn_from_reserve: i128,
    pub remaining_shortfall: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Penalized {
    #[topic]
    pub member: Address,
    pub penalty_amount: i128,
    pub balance_owed: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DebtPaid {
    #[topic]
    pub member: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Exited {
    #[topic]
    pub member: Address,
    pub refund: i128,
}

/// Distinct from `Exited`: a kick is a governance removal, not a member
/// leaving of their own accord, and an off-chain indexer needs to tell the
/// two apart.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Kicked {
    #[topic]
    pub member: Address,
    pub refund: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SwapRequested {
    #[topic]
    pub requester: Address,
    pub target: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SwapAccepted {
    #[topic]
    pub requester: Address,
    pub target: Address,
}

/// Published when a reputation write silently failed to record (writer
/// revoked, TTL-archived, contract unreachable, ...). Reputation reporting
/// is best-effort by design (see `reputation.rs`): a broken feed must never
/// be able to block contribute()/penalize()/gov_kick(), so a failure here
/// is swallowed rather than propagated — this event is the only signal an
/// indexer or organizer gets that the feed has gone stale.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReputationWriteFailed {
    #[topic]
    pub member: Address,
    pub kind: soroban_sdk::Symbol,
}
