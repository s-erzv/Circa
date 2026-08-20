use crate::config;
use crate::events::Kicked;
use crate::storage;
use crate::types::Error;
use soroban_sdk::{Address, Env};

/// Remove a member from wherever they sit in the queue and push them to the
/// back. This is not merely "defer to the back": called repeatedly against
/// the same member it amounts to arbitrary queue reordering, since nothing
/// stops gov from skipping the same address every cycle. The grief is
/// bounded, though — `distribute()` pops a paid recipient and never pushes
/// them back, so the queue strictly shrinks each cycle, guaranteeing the
/// victim is paid within at most `member_count - 1` cycles. (The practical
/// check on this power is that ArisanGov requires a 70% vote per skip,
/// which lives outside this contract.) This reuses the queue mechanics
/// `distribute()` already applies to a delinquent member, rather than
/// introducing a parallel "skipped" flag whose interaction with delinquency
/// would need its own rules.
pub fn gov_skip(env: &Env, member_addr: Address) -> Result<(), Error> {
    config::require_gov(env)?;
    let mut pool = storage::read_pool(env)?;
    if pool.closed {
        return Err(Error::PoolClosed);
    }
    let member = storage::read_member(env, &member_addr)?;
    if member.exited {
        return Err(Error::AlreadyExited);
    }
    let idx = pool
        .queue
        .first_index_of(&member_addr)
        .ok_or(Error::NotInQueue)?;
    pool.queue.remove(idx);
    pool.queue.push_back(member_addr);
    storage::write_pool(env, &pool);
    Ok(())
}

/// Remove a member by governance decision.
///
/// A member who has NOT received their payout is refunded on the same
/// terms as a voluntary exit: being voted out is not itself evidence of
/// wrongdoing, and confiscating a non-defaulter's money would hand the
/// majority an obvious incentive to kick people for their contributions.
///
/// A member who HAS an outstanding debt (`balance_owed > 0`) is reported
/// to the reputation contract as a default — this is the actual signal of
/// an outstanding obligation, regardless of whether it comes from a
/// pre-payout penalty or a post-payout default. A member kicked with
/// `balance_owed == 0` is NOT reported as a defaulter: they may have done
/// nothing wrong (e.g. a governance disagreement, or honest completion).
pub fn gov_kick(env: &Env, member_addr: Address) -> Result<(), Error> {
    config::require_gov(env)?;
    let pool = storage::read_pool(env)?;
    if pool.closed {
        return Err(Error::PoolClosed);
    }
    let owes_money = storage::read_member(env, &member_addr)?.balance_owed > 0;
    let refund = crate::exit::perform_removal(env, &member_addr)?;
    if owes_money {
        crate::reputation::report_default(env, &member_addr);
    }
    Kicked {
        member: member_addr,
        refund,
    }
    .publish(env);
    Ok(())
}
