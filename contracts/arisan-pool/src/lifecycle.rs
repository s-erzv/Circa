use crate::storage;
use crate::types::{Error, Member};
use soroban_sdk::Address;
use soroban_sdk::Env;

/// Reserves a seat. Moves no tokens — the queue-slot reservation itself is
/// the only effect until the pool activates — but still requires the
/// member's own signature: joining is a real commitment (it affects the
/// draw, and later governance/reputation treat this address as a real
/// member), just not a financial one yet.
///
/// Activating on the LAST join (rather than a separate call) removes any
/// window in which the roster is full but nobody has triggered the draw —
/// there is no such state to be in.
pub fn join(env: &Env, member_addr: Address) -> Result<(), Error> {
    member_addr.require_auth();
    let mut pool = storage::read_pool(env)?;
    if pool.activated {
        return Err(Error::PoolFull);
    }
    if pool.members.contains(&member_addr) {
        return Err(Error::AlreadyJoined);
    }
    if pool.members.len() >= pool.member_count {
        return Err(Error::PoolFull);
    }

    let new_member = Member {
        address: member_addr.clone(),
        total_contributed: 0,
        contributed_this_cycle: false,
        penalized_this_cycle: false,
        received_payout: false,
        balance_owed: 0,
        delinquent: false,
        exited: false,
    };
    storage::write_member(env, &new_member);

    pool.members.push_back(member_addr);

    if pool.members.len() == pool.member_count {
        pool.activated = true;
        pool.queue = crate::draw::draw_order(env, &pool.members);
        pool.current_cycle = 0;
        pool.cycle_deadline = env.ledger().timestamp() + pool.deadline_offset_secs;
    }

    storage::write_pool(env, &pool);
    Ok(())
}
