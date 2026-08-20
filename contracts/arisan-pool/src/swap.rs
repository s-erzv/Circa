use crate::events::{SwapAccepted, SwapRequested};
use crate::storage::{self, BUMP_THRESHOLD, BUMP_TO};
use crate::types::{DataKey, Error};
use soroban_sdk::{Address, Env};

/// Proposes swapping queue positions with another member. Two-step
/// (request/accept) rather than a single call so neither party can move
/// the other's position unilaterally — a swap changes who gets paid when,
/// which is exactly the kind of thing one member should not be able to
/// impose on another.
pub fn request_swap(env: &Env, requester: Address, target: Address) -> Result<(), Error> {
    requester.require_auth();
    let pool = storage::read_pool(env)?;
    if !pool.queue.contains(&requester) {
        return Err(Error::NotInQueue);
    }
    if !pool.queue.contains(&target) {
        return Err(Error::NotInQueue);
    }

    let key = DataKey::PendingSwap(target.clone());
    env.storage().persistent().set(&key, &requester);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);

    SwapRequested { requester, target }.publish(env);
    Ok(())
}

/// Confirms a pending swap. Only the named `target` can accept — checked
/// both by `require_auth()` (proves it's really them) and by matching the
/// stored requester (proves this specific swap was actually proposed to
/// them, not some other pending request keyed under their address).
pub fn accept_swap(env: &Env, target: Address, requester: Address) -> Result<(), Error> {
    target.require_auth();

    let key = DataKey::PendingSwap(target.clone());
    let stored_requester: Address = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NoPendingSwap)?;
    if stored_requester != requester {
        return Err(Error::SwapTargetMismatch);
    }
    env.storage().persistent().remove(&key);

    let mut pool = storage::read_pool(env)?;
    let idx_requester = pool
        .queue
        .first_index_of(&requester)
        .ok_or(Error::NotInQueue)?;
    let idx_target = pool
        .queue
        .first_index_of(&target)
        .ok_or(Error::NotInQueue)?;

    let requester_pos = pool.queue.get_unchecked(idx_requester);
    let target_pos = pool.queue.get_unchecked(idx_target);
    pool.queue.set(idx_requester, target_pos);
    pool.queue.set(idx_target, requester_pos);
    storage::write_pool(env, &pool);

    SwapAccepted { requester, target }.publish(env);
    Ok(())
}
