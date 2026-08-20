#![no_std]

mod types;

use soroban_sdk::{contract, contractclient, contractimpl, Address, Env};
pub use types::{DataKey, Error, Proposal, ProposalKind};

/// Percentage of ELIGIBLE voters (not of votes cast) that must vote yes.
/// Abstaining therefore counts against a proposal: removing someone from
/// their own savings circle should need broad affirmative agreement, not
/// just a majority of whoever happened to show up.
pub const APPROVAL_PERCENT: u32 = 70;

const BUMP_THRESHOLD: u32 = 17280;
const BUMP_TO: u32 = 518400;

/// The slice of ArisanPool that gov needs. Declared as a trait so gov calls
/// the pool through a generated client rather than linking the `arisan-pool`
/// crate directly. Linking the crate would pull in every one of its
/// `#[no_mangle]` contract functions (`create`, `join`, `contribute`,
/// `distribute`, `exit`, `pay_debt`, ...) and re-export them from the gov
/// wasm, letting a deployed ArisanGov advertise — and someone initialize —
/// a whole parasitic pool inside gov's own contract storage. `list_members`
/// returns exactly the state gov reads (see `active_members` below), so
/// that's the only method declared here.
#[contractclient(name = "PoolClient")]
pub trait PoolInterface {
    fn list_members(env: Env) -> soroban_sdk::Vec<Address>;
    fn gov_skip(env: Env, member: Address);
    fn gov_kick(env: Env, member: Address);
    fn is_activated(env: Env) -> bool;
    fn is_closed(env: Env) -> bool;
    fn has_received_payout(env: Env, member: Address) -> bool;
}

#[contract]
pub struct ArisanGov;

#[contractimpl]
impl ArisanGov {
    pub fn __constructor(env: Env, pool: Address, voting_window_secs: u64) {
        env.storage().instance().set(&DataKey::Pool, &pool);
        env.storage()
            .instance()
            .set(&DataKey::VotingWindow, &voting_window_secs);
        env.storage().instance().set(&DataKey::NextId, &0u32);
    }

    pub fn propose(env: Env, proposer: Address, kind: ProposalKind) -> Result<u32, Error> {
        proposer.require_auth();
        // Gate on activation. This is the root fix for the pre-activation
        // family of exploits (see `execute`'s comment on `max(snapshot,
        // live)` for the history): while the pool is still forming,
        // `pool.members` is still growing, so any snapshot taken now is
        // provably a stale floor, not a ceiling, and votes cast now bank
        // permanently against that stale floor with no way to unbank them
        // short of the voter exiting. Once the pool activates, `join` is
        // permanently blocked (`arisan-pool/src/lifecycle.rs`) and
        // membership can only shrink — so requiring activation here makes
        // the electorate MAXIMAL at propose time, which is exactly what
        // guarantees `live <= snapshot` for the rest of this proposal's
        // life. There is also nothing to govern before activation: no
        // tokens have moved, and a member unhappy with someone can simply
        // wait for them to fail to fill a seat, or `exit` and re-join
        // fresh — so gating this away costs nothing.
        if !Self::pool_activated(&env) {
            return Err(Error::PoolNotActivated);
        }
        if Self::pool_closed(&env) {
            return Err(Error::PoolClosed);
        }
        let members = Self::active_members(&env);
        if !members.contains(&proposer) {
            return Err(Error::NotAMember);
        }
        if !members.contains(&kind.subject()) {
            return Err(Error::SubjectNotAMember);
        }

        let id: u32 = env.storage().instance().get(&DataKey::NextId).unwrap();
        let window: u64 = env
            .storage()
            .instance()
            .get(&DataKey::VotingWindow)
            .unwrap();

        // Snapshot the yes-votes bar NOW, from the electorate as it stands
        // at propose time, and freeze it on the proposal as a FLOOR. Voters
        // are told (via `required_yes`/`eligible_voters`) what bar they're
        // voting against; that bar must never move DOWN later just because
        // the electorate shrinks post-activation. Because `propose` is now
        // gated on activation (above), the electorate is already maximal at
        // this point, so this snapshot is also a true CEILING for the rest
        // of this proposal's life — `execute`'s live recomputation is kept
        // as defense-in-depth, not because it's expected to ever exceed
        // this value. See the comment on `execute` for the full history.
        let subject = kind.subject();
        let eligible = Self::compute_eligible(&members, &subject);
        if eligible < 2 {
            return Err(Error::ElectorateTooSmall);
        }
        let required_yes = Self::compute_required_yes(eligible);

        let payout_snapshot = match &kind {
            ProposalKind::Kick(subj) => {
                let pool_addr: Address =
                    env.storage().instance().get(&DataKey::Pool).unwrap();
                PoolClient::new(&env, &pool_addr).has_received_payout(subj)
            }
            ProposalKind::Skip(_) => false,
        };

        let proposal = Proposal {
            id,
            kind,
            proposer,
            deadline: env.ledger().timestamp() + window,
            yes_votes: 0,
            no_votes: 0,
            executed: false,
            required_yes,
            payout_snapshot,
        };
        Self::write_proposal(&env, &proposal);
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        // I6: keep instance storage (Pool/VotingWindow/NextId) alive.
        env.storage()
            .instance()
            .extend_ttl(BUMP_THRESHOLD, BUMP_TO);
        Ok(id)
    }

    pub fn vote(env: Env, voter: Address, id: u32, approve: bool) -> Result<(), Error> {
        voter.require_auth();
        let mut proposal = Self::get_proposal(env.clone(), id)?;
        if proposal.executed {
            return Err(Error::AlreadyExecuted);
        }
        if env.ledger().timestamp() > proposal.deadline {
            return Err(Error::VotingClosed);
        }
        if voter == proposal.kind.subject() {
            return Err(Error::SubjectCannotVote);
        }

        let members = Self::active_members(&env);
        if !members.contains(&voter) {
            return Err(Error::NotAMember);
        }

        let vote_key = DataKey::Voted(id, voter);
        if env.storage().persistent().has(&vote_key) {
            return Err(Error::AlreadyVoted);
        }
        env.storage().persistent().set(&vote_key, &approve);
        env.storage()
            .persistent()
            .extend_ttl(&vote_key, BUMP_THRESHOLD, BUMP_TO);

        if approve {
            proposal.yes_votes += 1;
        } else {
            proposal.no_votes += 1;
        }
        Self::write_proposal(&env, &proposal);
        Ok(())
    }

    pub fn get_proposal(env: Env, id: u32) -> Result<Proposal, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Proposal(id))
            .ok_or(Error::ProposalNotFound)
    }

    pub fn has_voted(env: Env, id: u32, voter: Address) -> bool {
        env.storage().persistent().has(&DataKey::Voted(id, voter))
    }

    /// Active members excluding the proposal's subject, computed LIVE from
    /// the pool's current membership. `execute` DOES compute this same live
    /// quantity (it's half of `max(snapshot, live)`, see `execute`'s
    /// comment) — what it never uses is the *count* returned here directly;
    /// it derives its own bar from `compute_required_yes` applied to this
    /// same eligible figure. This function stays purely informational
    /// because now that `propose` is gated on pool activation, `live` can
    /// only ever be `<=` the frozen `required_yes` snapshot (membership only
    /// shrinks post-activation), so the number this reports is never the
    /// deciding factor in whether a proposal passes — `required_yes` below
    /// is.
    ///
    /// `list_members` is already the active set — ArisanPool removes a
    /// member from it on exit or kick — so this needs a single call rather
    /// than one per member.
    pub fn eligible_voters(env: Env, id: u32) -> Result<u32, Error> {
        let proposal = Self::get_proposal(env.clone(), id)?;
        let members = Self::active_members(&env);
        Ok(Self::compute_eligible(&members, &proposal.kind.subject()))
    }

    /// Yes-votes needed to execute, RIGHT NOW. `execute` enforces the harder
    /// of two bars — the propose-time snapshot (a floor against
    /// post-activation shrinkage) and a live recomputation from the pool's
    /// current membership (defense-in-depth kept from an earlier
    /// pre-activation exploit; see the comment on `execute`) — so this
    /// returns that same `max(...)`, not just the stored snapshot. A client
    /// asking "what does this proposal need to pass?" wants the number
    /// `execute` will actually check. In practice the two bars now always
    /// agree: `propose` is gated on `pool.activated`, so the electorate is
    /// already maximal at snapshot time and `live` can only fall or hold,
    /// never rise above it. (Compare `eligible_voters` above, which reports
    /// the live electorate SIZE rather than the vote bar — a different,
    /// purely informational question.)
    pub fn required_yes(env: Env, id: u32) -> Result<u32, Error> {
        let proposal = Self::get_proposal(env.clone(), id)?;
        let live = Self::compute_required_yes(Self::compute_eligible(
            &Self::active_members(&env),
            &proposal.kind.subject(),
        ));
        Ok(proposal.required_yes.max(live).max(2))
    }

    fn active_members(env: &Env) -> soroban_sdk::Vec<Address> {
        let pool_addr: Address = env.storage().instance().get(&DataKey::Pool).unwrap();
        PoolClient::new(env, &pool_addr).list_members()
    }

    fn pool_activated(env: &Env) -> bool {
        let pool_addr: Address = env.storage().instance().get(&DataKey::Pool).unwrap();
        PoolClient::new(env, &pool_addr).is_activated()
    }

    fn pool_closed(env: &Env) -> bool {
        let pool_addr: Address = env.storage().instance().get(&DataKey::Pool).unwrap();
        PoolClient::new(env, &pool_addr).is_closed()
    }

    /// Eligible-voter count: active members minus the subject, if the
    /// subject is (still) one of them. Saturating: if every member has
    /// since left the pool, `total` can be 0 while the subject is still
    /// named on an old proposal, and the release profile has
    /// overflow-checks on.
    fn compute_eligible(members: &soroban_sdk::Vec<Address>, subject: &Address) -> u32 {
        let total = members.len();
        if members.contains(subject) {
            total.saturating_sub(1)
        } else {
            total
        }
    }

    /// Yes-votes needed, rounding UP so a fractional requirement never
    /// rounds in favour of removing someone.
    fn compute_required_yes(eligible: u32) -> u32 {
        (eligible * APPROVAL_PERCENT + 99) / 100
    }

    /// Permissionless, like `ArisanPool::distribute` — anyone may push a
    /// decided proposal through, so execution does not depend on the
    /// goodwill of whoever happens to hold a privileged key.
    pub fn execute(env: Env, id: u32) -> Result<(), Error> {
        let mut proposal = Self::get_proposal(env.clone(), id)?;
        if proposal.executed {
            return Err(Error::AlreadyExecuted);
        }
        // The bar to clear is the HARDER of two numbers, not just one:
        //
        //  - `proposal.required_yes`: the bar SNAPSHOTTED at propose time.
        //    This is a FLOOR that protects against post-activation
        //    shrinkage. `join` is blocked once `activated` (see
        //    `arisan-pool/src/lifecycle.rs`), so after activation
        //    `pool.members` can only ever shrink. Without this floor, a
        //    dissenting NO voter could exit after a proposal was defeated,
        //    shrink the live electorate, lower the live bar below the
        //    already-cast (and insufficient) yes votes, and flip a
        //    defeated proposal to passing with no new votes cast — and
        //    since `execute` has no deadline, a defeated proposal would
        //    otherwise sit there indefinitely waiting for exactly that
        //    attrition.
        //
        //  - `live`: the bar recomputed NOW from `pool.members`. This was
        //    originally added to defend against the opposite,
        //    pre-activation direction: `propose`/`vote` used to have no
        //    activation gate, so a proposal could be raised and voted on
        //    while the pool was still tiny — e.g. 2 of an eventual 5 seats
        //    filled, snapshotting `required_yes` at 1 — then sit
        //    "permanently armed" while the remaining seats filled and the
        //    pool activated with real money moving. Worse, an attacker
        //    could bank votes with sybil addresses pre-activation and then
        //    *exit* those sybils after activation once a fresh vote
        //    honestly failed, shrinking `live` back down to meet the
        //    already-banked `yes_votes` — `yes_votes` is never decremented
        //    on exit, so attrition alone could revive a proposal that had
        //    already lost. `propose` is now gated on `pool.activated` (see
        //    its comment), which closes this at the root: `pool.members`
        //    can only be growing while unactivated, and `propose` refuses
        //    to run in that state, so by the time any snapshot is taken the
        //    electorate is already maximal for this proposal's entire life.
        //
        // INVARIANT: because `propose` now requires activation, `live` is
        // `<=` `proposal.required_yes` for every proposal that can exist —
        // there is no longer a window in which the live electorate can
        // exceed the snapshot, so `max` always reduces to
        // `proposal.required_yes` in practice. `live` and the `max()` are
        // kept anyway as defense-in-depth rather than removed: this
        // threshold logic has now had four Criticals found in it, the
        // activation gate and the snapshot floor are independent guards
        // that fail independently, and the cost of keeping `live` here is
        // one extra cross-contract read. If enough members ultimately
        // leave post-activation that the bar becomes unreachable, the
        // proposal simply fails forever — better to fail to remove someone
        // than to remove them without the mandate that was actually
        // agreed.
        let live = Self::compute_required_yes(Self::compute_eligible(
            &Self::active_members(&env),
            &proposal.kind.subject(),
        ));
        let bar = proposal.required_yes.max(live).max(2);

        // A floor of `yes_votes >= 1` on top of the threshold check is
        // defense-in-depth against a *different* zero-vote path: an
        // eligible electorate of 0 (e.g. a single-member pool where that
        // member proposes against themselves) snapshots `required_yes` at
        // 0 too, and `0 < 0` is false — so the threshold check alone would
        // let a completely unvoted, permissionless `execute` move money.
        // These two guards fail independently, so both stay.
        if proposal.yes_votes == 0 {
            return Err(Error::NoVotesCast);
        }
        if proposal.yes_votes < bar {
            return Err(Error::ThresholdNotMet);
        }

        let pool_addr: Address = env.storage().instance().get(&DataKey::Pool).unwrap();
        let pool = PoolClient::new(&env, &pool_addr);

        // I5 snapshot-and-verify: for Kick proposals, the subject's payout
        // status at propose time is snapshotted. If it has changed, the
        // proposal would execute under materially different terms than
        // what voters approved — e.g. voters approved a clean removal (no
        // payout yet), but the subject has since received their payout
        // (different refund/debt/reputation outcome). `received_payout`
        // only flips false→true, never back, so once this mismatch occurs
        // it is permanent — the correct recovery is a fresh `propose()`
        // against current state.
        if let ProposalKind::Kick(ref member) = proposal.kind {
            let current = pool.has_received_payout(member);
            if current != proposal.payout_snapshot {
                return Err(Error::SubjectStateChanged);
            }
        }

        match &proposal.kind {
            ProposalKind::Skip(member) => pool.gov_skip(member),
            ProposalKind::Kick(member) => pool.gov_kick(member),
        }

        proposal.executed = true;
        Self::write_proposal(&env, &proposal);
        Ok(())
    }

    fn write_proposal(env: &Env, proposal: &Proposal) {
        let key = DataKey::Proposal(proposal.id);
        env.storage().persistent().set(&key, proposal);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }
}

mod test;
