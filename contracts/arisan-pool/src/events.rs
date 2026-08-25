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
pub struct ReserveDistributed {
    pub per_member: i128,
    pub member_count: u32,
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

/// Published after each distribute() call once the queue has been re-drawn
/// for the following cycle. `next_recipient` is queue[0] after the draw —
/// the most useful single fact for an off-chain indexer (or bot) to display
/// without having to read the full pool state again.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Drew {
    /// The member who will receive the NEXT cycle's payout (queue[0] after
    /// re-draw). Absent only when the queue is empty (pool about to close).
    #[topic]
    pub next_recipient: Address,
    pub cycle: u32,
}

/// A member proposes swapping their queue position with another, offering a
/// fee (in token units) that will be credited to the reserve if accepted.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrioritySwapRequested {
    #[topic]
    pub requester: Address,
    #[topic]
    pub target: Address,
    pub fee: i128,
}

/// The target accepted the priority swap; positions and fee have been settled.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrioritySwapAccepted {
    #[topic]
    pub requester: Address,
    #[topic]
    pub target: Address,
    pub fee: i128,
}

/// The target rejected the priority swap request; no state changed.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrioritySwapRejected {
    #[topic]
    pub requester: Address,
    #[topic]
    pub target: Address,
}

/// The organizer force-closed the pool before all cycles completed. Each
/// eligible member (those who had not yet received a payout) received a
/// pro-rata share of the remaining funds.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForceClosed {
    pub refund_per_member: i128,
    pub eligible_count: u32,
}
