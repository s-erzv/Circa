use crate::events::{PrioritySwapAccepted, PrioritySwapRejected, PrioritySwapRequested};
use crate::storage::{self, BUMP_THRESHOLD, BUMP_TO};
use crate::types::{DataKey, DrawMode, Error, PrioritySwapRequest};
use soroban_sdk::{token, Address, Env, MuxedAddress, Vec};

fn read_bids(env: &Env, target: &Address) -> Vec<PrioritySwapRequest> {
    let key = DataKey::PendingPrioritySwap(target.clone());
    env.storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env))
}

fn write_bids(env: &Env, target: &Address, bids: &Vec<PrioritySwapRequest>) {
    let key = DataKey::PendingPrioritySwap(target.clone());
    if bids.is_empty() {
        env.storage().persistent().remove(&key);
    } else {
        env.storage().persistent().set(&key, bids);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }
}

/// Places a bid to swap into the front-of-queue slot, in exchange for a fee
/// that goes to the pool's reserve if accepted (distributed pro-rata to all
/// members at the end, rather than flowing directly to the target — avoids
/// bilateral payment that could be characterised as riba).
///
/// Multiple different requesters may each have an open bid on the same
/// target at once — the target isn't limited to whoever asked first, and
/// doesn't have to weigh *why* one request is more deserving than another
/// (unverifiable, and exactly the kind of subjective call this platform
/// exists to remove): `accept_priority_swap` mechanically enforces that only
/// the currently-highest bid can ever be accepted. What the target keeps is
/// the one thing genuinely theirs to decide: whether to give up the slot at
/// all.
///
/// The fee is escrowed into the contract here, at bid time — NOT pulled
/// later when the target accepts. `accept_priority_swap` runs in a separate
/// transaction that only the target signs; a SEP-41 `transfer` always
/// requires the FROM address's own live authorization, which a requester has
/// no way to provide in a transaction they are not a party to. Escrowing
/// now, while the requester IS the one signing, is what makes the fee
/// actually collectible at all.
pub fn request_priority_swap(
    env: &Env,
    requester: Address,
    target: Address,
    fee: i128,
) -> Result<(), Error> {
    requester.require_auth();

    if requester == target {
        return Err(Error::CannotSwapSelf);
    }
    if fee <= 0 {
        return Err(Error::FeeTooLow);
    }

    let pool = storage::read_pool(env)?;
    if !pool.activated {
        return Err(Error::PoolNotActivated);
    }
    if pool.closed {
        return Err(Error::PoolClosed);
    }

    if !pool.queue.contains(&requester) {
        return Err(Error::NotInQueue);
    }
    let tgt_pos = pool.queue.first_index_of(&target).ok_or(Error::NotInQueue)?;

    match pool.draw_mode {
        // Only queue[0] is ever worth bidding on here — distribute() re-
        // shuffles the ENTIRE remaining queue after every single payout, so
        // any position other than 0 gets scrambled away before the next
        // cycle even matters. Position 0 alone is real: it's who gets paid
        // at the very next distribute(), before any further reshuffle.
        DrawMode::PerCycle => {
            if tgt_pos != 0 {
                return Err(Error::PrioritySwapTargetNotFront);
            }
        }
        // The order is fixed for the pool's whole life, so any earlier
        // position genuinely sticks — same rule as the original design:
        // requester must be later in queue than target (paying to move
        // earlier).
        DrawMode::Upfront => {
            let req_pos = pool.queue.first_index_of(&requester).ok_or(Error::NotInQueue)?;
            if req_pos <= tgt_pos {
                return Err(Error::NotInQueue);
            }
        }
    }

    let mut bids = read_bids(env, &target);
    // One open bid per requester per target — someone wanting to raise
    // their own offer needs the target to resolve (accept/reject) the
    // current round first, same as the rest of this auction's resolution
    // model. Prevents one address from quietly holding multiple escrowed
    // bids on the same slot.
    if bids.iter().any(|b| b.requester == requester) {
        return Err(Error::PrioritySwapAlreadyPending);
    }

    let token_client = token::Client::new(env, &pool.token);
    token_client.transfer(
        &requester,
        &MuxedAddress::from(&env.current_contract_address()),
        &fee,
    );

    bids.push_back(PrioritySwapRequest {
        requester: requester.clone(),
        fee,
    });
    write_bids(env, &target, &bids);

    PrioritySwapRequested { requester, target, fee }.publish(env);
    Ok(())
}

/// The target accepts one specific requester's bid — but only if it is
/// currently the highest of everyone bidding on this slot. Enforcing that
/// mechanically (rather than letting the target cherry-pick) is what keeps
/// slot allocation objective: the rule is always "highest bid wins", never
/// "whoever the target likes best".
///
///   1. Credits the accepted bid's escrowed fee to the pool reserve.
///   2. Refunds every OTHER bidder's escrowed fee back to them.
///   3. Swaps target and the accepted requester's queue positions.
///   4. Clears every pending bid on this target.
pub fn accept_priority_swap(
    env: &Env,
    target: Address,
    requester: Address,
) -> Result<(), Error> {
    target.require_auth();

    let bids = read_bids(env, &target);
    if bids.is_empty() {
        return Err(Error::NoPendingPrioritySwap);
    }

    let accepted = bids
        .iter()
        .find(|b| b.requester == requester)
        .ok_or(Error::PrioritySwapRequesterNotFound)?;

    let highest_fee = bids.iter().map(|b| b.fee).max().unwrap_or(0);
    if accepted.fee != highest_fee {
        return Err(Error::PrioritySwapNotHighestBid);
    }

    let mut pool = storage::read_pool(env)?;
    if pool.closed {
        return Err(Error::PoolClosed);
    }

    let token_client = token::Client::new(env, &pool.token);
    for bid in bids.iter() {
        if bid.requester == requester {
            pool.reserve_balance += bid.fee;
        } else {
            token_client.transfer(
                &env.current_contract_address(),
                &MuxedAddress::from(&bid.requester),
                &bid.fee,
            );
        }
    }

    // Swap positions in queue.
    let idx_requester = pool
        .queue
        .first_index_of(&requester)
        .ok_or(Error::NotInQueue)?;
    let idx_target = pool
        .queue
        .first_index_of(&target)
        .ok_or(Error::NotInQueue)?;

    let req_slot = pool.queue.get_unchecked(idx_requester);
    let tgt_slot = pool.queue.get_unchecked(idx_target);
    pool.queue.set(idx_requester, tgt_slot);
    pool.queue.set(idx_target, req_slot);
    storage::write_pool(env, &pool);

    write_bids(env, &target, &Vec::new(env));

    PrioritySwapAccepted {
        requester,
        target,
        fee: accepted.fee,
    }
    .publish(env);
    Ok(())
}

/// The target declines the whole auction. Every open bidder's escrowed fee
/// refunds back to them; all pending bids on this target are cleared.
/// Requesters may bid again afterward.
pub fn reject_priority_swap(env: &Env, target: Address) -> Result<(), Error> {
    target.require_auth();

    let bids = read_bids(env, &target);
    if bids.is_empty() {
        return Err(Error::NoPendingPrioritySwap);
    }

    let pool = storage::read_pool(env)?;
    let token_client = token::Client::new(env, &pool.token);
    for bid in bids.iter() {
        token_client.transfer(
            &env.current_contract_address(),
            &MuxedAddress::from(&bid.requester),
            &bid.fee,
        );
        PrioritySwapRejected {
            requester: bid.requester.clone(),
            target: target.clone(),
        }
        .publish(env);
    }

    write_bids(env, &target, &Vec::new(env));
    Ok(())
}
