use soroban_sdk::{contracterror, contracttype, Address, Vec};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Pool {
    pub organizer: Address,
    pub token: Address,
    /// The one address allowed to call `contribute_via_gateway` — set once,
    /// at construction, by whoever deploys the pool (never organizer- or
    /// gov-settable). See `cycle::contribute_via_gateway`'s doc comment for
    /// why that immutability is load-bearing.
    pub gateway: Address,
    pub contribution_amount: i128,
    pub member_count: u32,
    pub cycle_length_secs: u64,
    pub deadline_offset_secs: u64,
    pub penalty_amount: i128,
    pub exit_penalty_amount: i128,
    pub reserve_bps: u32,
    pub members: Vec<Address>,
    pub queue: Vec<Address>,
    pub activated: bool,
    pub current_cycle: u32,
    pub cycle_deadline: u64,
    pub cycle_pot: i128,
    pub reserve_balance: i128,
    pub closed: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Member {
    pub address: Address,
    pub total_contributed: i128,
    pub contributed_this_cycle: bool,
    pub penalized_this_cycle: bool,
    pub received_payout: bool,
    pub balance_owed: i128,
    pub delinquent: bool,
    pub exited: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Pool,
    Member(Address),
    PendingSwap(Address),
    Gov,
    Reputation,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    PoolAlreadyExists = 1,
    PoolNotFound = 2,
    PoolAlreadyActivated = 3,
    PoolFull = 4,
    PoolNotActivated = 5,
    PoolClosed = 6,
    MemberNotFound = 7,
    AlreadyJoined = 8,
    AlreadyContributed = 9,
    DeadlineNotPassed = 10,
    AlreadyPenalizedThisCycle = 11,
    NoEligibleRecipient = 12,
    AlreadyExited = 13,
    OutstandingDebt = 14,
    NoOutstandingDebt = 15,
    NotInQueue = 16,
    NoPendingSwap = 17,
    SwapTargetMismatch = 18,
    InvalidAmount = 19,
    GovNotConfigured = 20,
    NotGov = 21, // Reserved: unauthorized-gov failures currently surface via require_auth's own error, not this variant.
    AlreadyConfigured = 22,
}
