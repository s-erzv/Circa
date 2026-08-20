use crate::events::Exited;
use crate::storage;
use crate::types::Error;
use soroban_sdk::{token, Address, Env, MuxedAddress};

pub fn exit(env: &Env, member_addr: Address) -> Result<(), Error> {
    member_addr.require_auth();
    let member = storage::read_member(env, &member_addr)?;
    if member.exited {
        return Err(Error::AlreadyExited);
    }
    // A member who already took their lump-sum payout may not walk away
    // while still owing the pool — the "take the payout and disappear"
    // pattern this lock exists to prevent.
    if member.received_payout && member.balance_owed > 0 {
        return Err(Error::OutstandingDebt);
    }

    let refund = perform_removal(env, &member_addr)?;

    Exited {
        member: member_addr,
        refund,
    }
    .publish(env);
    Ok(())
}

/// Removes a member from the pool and settles their current-cycle money.
/// Shared by voluntary `exit()` and governance `gov_kick()`; the debt check
/// lives in `exit()` alone, because a kick must be able to remove a member
/// who is refusing to pay.
///
/// Returns the refund actually transferred.
pub fn perform_removal(env: &Env, member_addr: &Address) -> Result<i128, Error> {
    let mut pool = storage::read_pool(env)?;
    let mut member = storage::read_member(env, member_addr)?;
    if member.exited {
        return Err(Error::AlreadyExited);
    }

    let mut refund: i128 = 0;

    if !member.received_payout {
        // Refund is based on the CURRENT cycle's contribution only, never on
        // total_contributed: money from prior cycles was already paid out to
        // prior recipients, so the contract does not hold it. Refunding it
        // would either revert on insufficient balance or silently desync
        // cycle_pot / reserve_balance from the real token balance.
        let gross_this_cycle = if member.contributed_this_cycle {
            pool.contribution_amount
        } else {
            0
        };
        let raw_refund = gross_this_cycle - pool.exit_penalty_amount;
        refund = if raw_refund > 0 { raw_refund } else { 0 };

        if gross_this_cycle > 0 {
            // The whole current-cycle contribution leaves the pot: the
            // refunded part leaves the contract, and the retained penalty
            // moves to reserve_balance — the same destination pay_debt()
            // sends collected penalties to. Leaving the penalty in cycle_pot
            // would hand it to this cycle's recipient as a windfall.
            pool.cycle_pot -= gross_this_cycle;
            pool.reserve_balance += gross_this_cycle - refund;
        }

        if refund > 0 {
            let token_client = token::Client::new(env, &pool.token);
            token_client.transfer(
                &env.current_contract_address(),
                &MuxedAddress::from(member_addr),
                &refund,
            );
        }
    }

    member.exited = true;
    storage::write_member(env, &member);

    if let Some(idx) = pool.queue.first_index_of(member_addr) {
        pool.queue.remove(idx);
    }
    // Before activation `queue` is empty (it is only built when the pool
    // fills), so removing from `queue` alone is a no-op and draw_order()
    // would later rebuild the queue from `members` — putting an exited
    // member back into the rotation, unable to contribute (AlreadyExited)
    // or re-join (AlreadyJoined). Remove from `members` too.
    if let Some(idx) = pool.members.first_index_of(member_addr) {
        pool.members.remove(idx);
    }
    storage::write_pool(env, &pool);

    Ok(refund)
}
