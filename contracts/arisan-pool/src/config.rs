use crate::storage;
use crate::types::{DataKey, Error};
use soroban_sdk::{Address, Env};

/// Gov and reputation are settable exactly once each, and only before the
/// pool activates. The single-shot check alone stops the organizer from
/// *re-pointing* governance mid-pool, but does nothing to stop *initial
/// capture*: without the activation guard, an organizer could let members
/// join and contribute while `get_gov()` is still `None`, then set `gov` to
/// an ordinary account they control — an address that satisfies
/// `require_auth()` with a plain signature — and hold unilateral kick/skip
/// power over money members already committed.
///
/// The activation guard closes that by making the two mutually exclusive:
/// `set_gov` requires `!activated`, and `contribute()` requires
/// `activated`. No token ever moves before activation (`join()` only
/// reserves a queue slot), so by the time any member's money is at risk,
/// `gov` is already frozen and readable through the no-auth `get_gov()`
/// view. A member can therefore check exactly who holds kick/skip power
/// right up until their first `contribute()`, and walking away before that
/// costs them nothing.
///
/// What this does NOT prevent: an organizer setting `gov` to a colluding
/// address in the window between `create()` and the pool filling. That is
/// deliberate — it reduces to a disclosure the member can inspect for free
/// rather than a capture of funds already committed.
///
/// Consequence worth knowing: an organizer who never calls `set_gov` before
/// the pool fills can never configure governance for that pool at all.
pub fn set_gov(env: &Env, gov: Address) -> Result<(), Error> {
    let pool = storage::read_pool(env)?;
    pool.organizer.require_auth();
    if pool.activated {
        return Err(Error::PoolAlreadyActivated);
    }
    if env.storage().instance().has(&DataKey::Gov) {
        return Err(Error::AlreadyConfigured);
    }
    env.storage().instance().set(&DataKey::Gov, &gov);
    Ok(())
}

pub fn get_gov(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::Gov)
}

/// See `set_gov`'s doc comment: the same pre-activation guard applies here,
/// for the same reason — a reputation contract swapped in after members
/// have committed money is just as much a trust problem as governance
/// captured after the fact.
pub fn set_reputation(env: &Env, reputation: Address) -> Result<(), Error> {
    let pool = storage::read_pool(env)?;
    pool.organizer.require_auth();
    if pool.activated {
        return Err(Error::PoolAlreadyActivated);
    }
    if env.storage().instance().has(&DataKey::Reputation) {
        return Err(Error::AlreadyConfigured);
    }
    env.storage()
        .instance()
        .set(&DataKey::Reputation, &reputation);
    Ok(())
}

pub fn get_reputation(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::Reputation)
}

/// Organizer-authorized, permanent off switch for reputation reporting.
/// Clears `DataKey::Reputation` back to unset. Unlike `set_reputation`, this
/// is NOT gated on `!activated` and does NOT re-point to a new address —
/// deliberately asymmetric with `set_gov`/`set_reputation`'s pre-activation
/// guard. That guard exists to stop an organizer from GAINING power after
/// money is committed (a capture risk). Turning reporting off grants no one
/// any new power — it only stops a data feed — so there is no analogous
/// capture risk to guard against, and restricting this to pre-activation
/// would defeat its only purpose: recovering post-activation from a
/// reputation contract that has gone bad (revoked writer, archived TTL,
/// unreachable), which is exactly the class of problem C1a's non-fatal
/// writes already make survivable but this makes stoppable.
///
/// One-way once activated: `set_reputation` still requires `!activated`, so
/// calling this after activation permanently forfeits reputation tracking
/// for this pool — there is no way back to a configured state. That's the
/// intended trade.
pub fn clear_reputation(env: &Env) -> Result<(), Error> {
    let pool = storage::read_pool(env)?;
    pool.organizer.require_auth();
    env.storage().instance().remove(&DataKey::Reputation);
    Ok(())
}

/// Proves the caller is the configured gov contract. Relies on the fact
/// that a contract invoking another contract natively satisfies
/// `require_auth()` on its own address.
pub fn require_gov(env: &Env) -> Result<(), Error> {
    let gov = get_gov(env).ok_or(Error::GovNotConfigured)?;
    gov.require_auth();
    Ok(())
}
