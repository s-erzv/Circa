use crate::events::{PrioritySwapAccepted, PrioritySwapRejected, PrioritySwapRequested};
use crate::storage::{self, BUMP_THRESHOLD, BUMP_TO};
use crate::types::{DataKey, Error, PrioritySwapRequest};
use soroban_sdk::{token, Address, Env, MuxedAddress};

/// Proposes swapping queue positions with a member who has an earlier slot,
/// in exchange for a fee that goes to the pool's reserve (distributed
/// pro-rata to all members at the end, rather than flowing directly to the
/// target — avoids bilateral payment that could be characterised as riba).
///
/// The fee is escrowed into the contract here, at request time — NOT pulled
/// later when the target accepts. `accept_priority_swap` runs in a separate
/// transaction that only the target signs; a SEP-41 `transfer` always
/// requires the FROM address's own live authorization, which the requester
/// has no way to provide in a transaction they are not a party to. Escrowing
/// now, while the requester IS the one signing, is what makes the fee
/// actually collectible at all — pulling it at accept time would work under
/// `mock_all_auths()` in tests but can never succeed on a real network.
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
    if !pool.queue.contains(&target) {
        return Err(Error::NotInQueue);
    }

    // Requester must be LATER in queue than target (paying to move earlier).
    let req_pos = pool.queue.first_index_of(&requester).ok_or(Error::NotInQueue)?;
    let tgt_pos = pool.queue.first_index_of(&target).ok_or(Error::NotInQueue)?;
    if req_pos <= tgt_pos {
        return Err(Error::NotInQueue);
    }

    let key = DataKey::PendingPrioritySwap(target.clone());
    // Storage is keyed by target alone — a second, different requester
    // targeting the same person would otherwise silently overwrite the
    // first pending request with no trace, and the first requester would
    // never know their offer vanished (and never get their escrowed fee
    // back automatically). Require the target to resolve (accept/reject)
    // whatever's already pending before a new one can replace it.
    if env.storage().persistent().has(&key) {
        return Err(Error::PrioritySwapAlreadyPending);
    }

    let token_client = token::Client::new(env, &pool.token);
    token_client.transfer(
        &requester,
        &MuxedAddress::from(&env.current_contract_address()),
        &fee,
    );

    let request = PrioritySwapRequest {
        requester: requester.clone(),
        fee,
    };
    env.storage().persistent().set(&key, &request);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);

    PrioritySwapRequested { requester, target, fee }.publish(env);
    Ok(())
}

/// The target accepts the priority-swap proposal:
///   1. Credits the already-escrowed `fee` to the pool reserve (no transfer
///      needed — it arrived at request time).
///   2. Swaps their queue positions.
///   3. Clears the pending request.
pub fn accept_priority_swap(
    env: &Env,
    target: Address,
    requester: Address,
) -> Result<(), Error> {
    target.require_auth();

    let key = DataKey::PendingPrioritySwap(target.clone());
    let stored: PrioritySwapRequest = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NoPendingPrioritySwap)?;
    if stored.requester != requester {
        return Err(Error::PrioritySwapTargetMismatch);
    }
    env.storage().persistent().remove(&key);

    let mut pool = storage::read_pool(env)?;
    if pool.closed {
        return Err(Error::PoolClosed);
    }

    pool.reserve_balance += stored.fee;

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

    PrioritySwapAccepted {
        requester,
        target,
        fee: stored.fee,
    }
    .publish(env);
    Ok(())
}

/// The target rejects the proposal. The escrowed fee refunds back to the
/// requester (the deal fell through — they should not be left having paid
/// for nothing); pending request cleared. Requester may propose again, to
/// this or another target, with a fresh fee.
pub fn reject_priority_swap(env: &Env, target: Address) -> Result<(), Error> {
    target.require_auth();

    let key = DataKey::PendingPrioritySwap(target.clone());
    let stored: PrioritySwapRequest = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NoPendingPrioritySwap)?;
    env.storage().persistent().remove(&key);

    let pool = storage::read_pool(env)?;
    let token_client = token::Client::new(env, &pool.token);
    token_client.transfer(
        &env.current_contract_address(),
        &MuxedAddress::from(&stored.requester),
        &stored.fee,
    );

    PrioritySwapRejected {
        requester: stored.requester,
        target,
    }
    .publish(env);
    Ok(())
}
