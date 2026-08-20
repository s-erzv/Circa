#![no_std]

mod storage;
mod types;
mod draw;
mod lifecycle;
mod cycle;
mod config;
mod govops;
mod events;
mod exit;
mod swap;
mod reputation;

use soroban_sdk::{contract, contractimpl, Address, Env};
pub use types::{Error, Member, Pool};

/// Maximum reserve skim, in basis points (10% of each payout). The design
/// intent is 2-3%; the hard ceiling that keeps `net_payout` non-negative is
/// 10000 bps, and this is a deliberately tighter practical cap.
pub const MAX_RESERVE_BPS: u32 = 1000;

#[contract]
pub struct ArisanPool;

#[contractimpl]
impl ArisanPool {
    pub fn create(
        env: Env,
        organizer: Address,
        token: Address,
        contribution_amount: i128,
        member_count: u32,
        cycle_length_secs: u64,
        deadline_offset_secs: u64,
        penalty_amount: i128,
        exit_penalty_amount: i128,
        reserve_bps: u32,
    ) -> Result<(), Error> {
        organizer.require_auth();
        if storage::has_pool(&env) {
            return Err(Error::PoolAlreadyExists);
        }
        if contribution_amount <= 0 || penalty_amount < 0 || exit_penalty_amount < 0 {
            return Err(Error::InvalidAmount);
        }
        if member_count < 2 {
            return Err(Error::InvalidAmount);
        }
        // reserve_bps above 10000 would make distribute()'s skim exceed the
        // gross pot, producing a negative net_payout that the token transfer
        // rejects — every future distribute() would revert forever, permanently
        // locking all contributions. The cap here is tighter than that hard
        // 10000 limit: the design calls for a 2-3% skim, and a pool that
        // diverts more than 10% of every payout into a reserve nobody can
        // withdraw directly is economically indistinguishable from a rug.
        if reserve_bps > MAX_RESERVE_BPS {
            return Err(Error::InvalidAmount);
        }
        // distribute() and penalize() are permissionless but deadline-gated;
        // a zero-length cycle would collapse that gate to "once per ledger".
        if cycle_length_secs == 0 || deadline_offset_secs == 0 {
            return Err(Error::InvalidAmount);
        }

        let pool = Pool {
            organizer,
            token,
            contribution_amount,
            member_count,
            cycle_length_secs,
            deadline_offset_secs,
            penalty_amount,
            exit_penalty_amount,
            reserve_bps,
            members: soroban_sdk::Vec::new(&env),
            queue: soroban_sdk::Vec::new(&env),
            activated: false,
            current_cycle: 0,
            cycle_deadline: 0,
            cycle_pot: 0,
            reserve_balance: 0,
            closed: false,
        };
        storage::write_pool(&env, &pool);
        Ok(())
    }

    pub fn get_pool(env: Env) -> Result<Pool, Error> {
        storage::read_pool(&env)
    }

    pub fn join(env: Env, member: Address) -> Result<(), Error> {
        lifecycle::join(&env, member)
    }

    pub fn contribute(env: Env, member: Address) -> Result<(), Error> {
        cycle::contribute(&env, member)
    }

    pub fn distribute(env: Env) -> Result<(), Error> {
        cycle::distribute(&env)
    }

    pub fn penalize(env: Env, member: Address) -> Result<(), Error> {
        cycle::penalize(&env, member)
    }

    pub fn pay_debt(env: Env, member: Address, amount: i128) -> Result<(), Error> {
        cycle::pay_debt(&env, member, amount)
    }

    pub fn exit(env: Env, member: Address) -> Result<(), Error> {
        exit::exit(&env, member)
    }

    pub fn set_gov(env: Env, gov: Address) -> Result<(), Error> {
        config::set_gov(&env, gov)
    }

    pub fn get_gov(env: Env) -> Option<Address> {
        config::get_gov(&env)
    }

    pub fn set_reputation(env: Env, reputation: Address) -> Result<(), Error> {
        config::set_reputation(&env, reputation)
    }

    pub fn get_reputation(env: Env) -> Option<Address> {
        config::get_reputation(&env)
    }

    pub fn clear_reputation(env: Env) -> Result<(), Error> {
        config::clear_reputation(&env)
    }

    pub fn gov_skip(env: Env, member: Address) -> Result<(), Error> {
        govops::gov_skip(&env, member)
    }

    pub fn gov_kick(env: Env, member: Address) -> Result<(), Error> {
        govops::gov_kick(&env, member)
    }

    pub fn request_swap(env: Env, requester: Address, target: Address) -> Result<(), Error> {
        swap::request_swap(&env, requester, target)
    }

    pub fn accept_swap(env: Env, target: Address, requester: Address) -> Result<(), Error> {
        swap::accept_swap(&env, target, requester)
    }

    pub fn list_members(env: Env) -> Result<soroban_sdk::Vec<Address>, Error> {
        Ok(storage::read_pool(&env)?.members)
    }

    /// Whether the pool has activated (every seat filled, `join` now
    /// permanently blocked, membership can only shrink from here on).
    /// Exposed as a primitive `bool`, not the `Pool` struct, specifically so
    /// gov can gate `propose` on it via `PoolInterface` without gaining a
    /// dependency on the pool crate — pulling in `Pool` (or the crate
    /// itself) would re-export all of the pool's own contract functions from
    /// gov's wasm, exactly the leak a prior fix removed.
    pub fn is_activated(env: Env) -> Result<bool, Error> {
        Ok(storage::read_pool(&env)?.activated)
    }

    /// Whether the pool has closed (all payouts distributed). Exposed as a
    /// primitive `bool`, not the `Pool` struct, for the same reason as
    /// `is_activated` — gov needs to gate `propose` on it without gaining a
    /// dependency on the pool crate.
    pub fn is_closed(env: Env) -> Result<bool, Error> {
        Ok(storage::read_pool(&env)?.closed)
    }

    pub fn get_member(env: Env, member: Address) -> Result<Member, Error> {
        storage::read_member(&env, &member)
    }

    pub fn has_received_payout(env: Env, member: Address) -> Result<bool, Error> {
        Ok(storage::read_member(&env, &member)?.received_payout)
    }
}

#[cfg(test)]
mod test;
