use crate::events::{Contributed, DebtPaid, Distributed, Penalized};
use crate::storage;
use crate::types::Error;
use soroban_sdk::{token, Address, Env, MuxedAddress};

/// Shared body of `contribute()`/`contribute_via_gateway()` — identical in
/// every way except WHO pays and WHO must authorize it. `payer` is asserted
/// to `require_auth()` before anything else moves, so a caller can never
/// mark a member as contributed without the asserted payer's real signature
/// backing an actual token transfer.
fn contribute_from(env: &Env, payer: Address, member_addr: Address) -> Result<(), Error> {
    payer.require_auth();
    let mut pool = storage::read_pool(env)?;
    if !pool.activated {
        return Err(Error::PoolNotActivated);
    }
    if pool.closed {
        return Err(Error::PoolClosed);
    }
    let mut member = storage::read_member(env, &member_addr)?;
    if member.exited {
        return Err(Error::AlreadyExited);
    }
    if member.contributed_this_cycle {
        return Err(Error::AlreadyContributed);
    }

    let token_client = token::Client::new(env, &pool.token);
    let contract_addr = env.current_contract_address();
    token_client.transfer(
        &payer,
        &MuxedAddress::from(&contract_addr),
        &pool.contribution_amount,
    );

    member.contributed_this_cycle = true;
    member.total_contributed += pool.contribution_amount;
    storage::write_member(env, &member);

    pool.cycle_pot += pool.contribution_amount;
    let amount = pool.contribution_amount;
    storage::write_pool(env, &pool);

    // On-time vs late is decided by the cycle deadline. A member already
    // penalized this cycle is NOT recorded late again here — penalize()
    // recorded that missed deadline, and counting it twice would
    // double-penalize one lapse.
    if env.ledger().timestamp() <= pool.cycle_deadline {
        crate::reputation::report_on_time(env, &member_addr);
    } else if !member.penalized_this_cycle {
        crate::reputation::report_late(env, &member_addr);
    }

    Contributed {
        member: member_addr,
        amount,
    }
    .publish(env);

    // I6: keep instance storage (Gov/Reputation addresses) alive for as
    // long as the pool is actively used.
    env.storage().instance().extend_ttl(
        crate::storage::BUMP_THRESHOLD,
        crate::storage::BUMP_TO,
    );

    Ok(())
}

pub fn contribute(env: &Env, member_addr: Address) -> Result<(), Error> {
    contribute_from(env, member_addr.clone(), member_addr)
}

/// Records a contribution paid through the QRIS gateway (deposits don't
/// need the member's own live signature — money moving INTO a pool on
/// someone's behalf can't be used to steal from them, only to (harmlessly)
/// credit them, unlike `exit()`/`pay_debt()` which move money the other
/// way and rightly require the member's own auth). The actual transfer is
/// sourced from `pool.gateway` — set once, at construction, never
/// organizer- or gov-settable — so crediting a contribution is always tied
/// to a real transfer the gateway itself authorized, not free bookkeeping
/// a captured `gateway` address could forge.
pub fn contribute_via_gateway(env: &Env, member_addr: Address) -> Result<(), Error> {
    let pool = storage::read_pool(env)?;
    contribute_from(env, pool.gateway, member_addr)
}

/// Pays a cycle's payout to the front-of-queue member still eligible for
/// one (delinquent members are skipped, cycling to the back exactly like
/// `gov_skip` does, so a defaulter's turn is deferred rather than
/// forfeited). Permissionless and deadline-gated — see the module-level
/// doc on `callPermissionless`-style reasoning: a payout must never be
/// something only a privileged caller can trigger.
pub fn distribute(env: &Env) -> Result<(), Error> {
    let mut pool = storage::read_pool(env)?;
    if !pool.activated {
        return Err(Error::PoolNotActivated);
    }
    if pool.closed {
        return Err(Error::PoolClosed);
    }
    // Deadline gate. distribute() is intentionally permissionless (anyone can
    // trigger a cycle's payout, exactly like penalize()), so without this gate
    // an attacker could call it repeatedly in a single ledger, burning through
    // every member's turn and closing the pool while moving ~zero funds.
    // Because each successful call pushes cycle_deadline out to
    // `now + cycle_length_secs`, this single check makes a rapid second call
    // fail — the pot can only be paid out once per cycle window.
    // Mirrors the exact comparison penalize() uses.
    if env.ledger().timestamp() <= pool.cycle_deadline {
        return Err(Error::DeadlineNotPassed);
    }

    let attempts = pool.queue.len();
    let mut recipient: Option<Address> = None;
    let mut i: u32 = 0;
    while i < attempts {
        let candidate = pool.queue.pop_front().unwrap();
        let candidate_member = storage::read_member(env, &candidate)?;
        if candidate_member.delinquent {
            pool.queue.push_back(candidate);
        } else {
            recipient = Some(candidate);
            break;
        }
        i += 1;
    }

    let recipient = match recipient {
        Some(r) => r,
        None => {
            storage::write_pool(env, &pool);
            return Err(Error::NoEligibleRecipient);
        }
    };

    // Active members still in the rotation — perform_removal() already
    // strips exited/kicked members out of `pool.members`, so its length is
    // exactly the count of members whose contribution is expected this
    // cycle.
    let active_members = pool.members.len();
    let expected_pot = pool.contribution_amount * (active_members as i128);
    let shortfall = if expected_pot > pool.cycle_pot {
        expected_pot - pool.cycle_pot
    } else {
        0
    };
    let drawn = if shortfall > pool.reserve_balance {
        pool.reserve_balance
    } else {
        shortfall
    };
    pool.reserve_balance -= drawn;
    let remaining_shortfall = shortfall - drawn;

    let gross = pool.cycle_pot + drawn;
    let skim = (gross * (pool.reserve_bps as i128)) / 10000;
    let net_payout = gross - skim;
    pool.reserve_balance += skim;

    let token_client = token::Client::new(env, &pool.token);
    token_client.transfer(
        &env.current_contract_address(),
        &MuxedAddress::from(&recipient),
        &net_payout,
    );

    let mut recipient_member = storage::read_member(env, &recipient)?;
    recipient_member.received_payout = true;
    storage::write_member(env, &recipient_member);

    for addr in pool.members.iter() {
        let mut m = storage::read_member(env, &addr)?;
        if m.contributed_this_cycle || m.penalized_this_cycle {
            m.contributed_this_cycle = false;
            m.penalized_this_cycle = false;
            storage::write_member(env, &m);
        }
    }

    pool.cycle_pot = 0;
    pool.current_cycle += 1;
    pool.cycle_deadline = env.ledger().timestamp() + pool.deadline_offset_secs;
    if pool.queue.is_empty() {
        pool.closed = true;
    }
    storage::write_pool(env, &pool);

    Distributed {
        recipient,
        net_payout,
        drawn_from_reserve: drawn,
        remaining_shortfall,
    }
    .publish(env);
    Ok(())
}

/// Flags a member who missed the cycle deadline without contributing.
/// Permissionless, like `distribute()` — the same "must not depend on a
/// privileged caller" reasoning applies: a late member should not be able
/// to avoid the penalty just because nobody with special access happened
/// to call this.
pub fn penalize(env: &Env, member_addr: Address) -> Result<(), Error> {
    let pool = storage::read_pool(env)?;
    if !pool.activated {
        return Err(Error::PoolNotActivated);
    }
    if pool.closed {
        return Err(Error::PoolClosed);
    }
    if env.ledger().timestamp() <= pool.cycle_deadline {
        return Err(Error::DeadlineNotPassed);
    }

    let mut member = storage::read_member(env, &member_addr)?;
    if member.exited {
        return Err(Error::AlreadyExited);
    }
    if member.contributed_this_cycle {
        return Err(Error::AlreadyContributed);
    }
    if member.penalized_this_cycle {
        return Err(Error::AlreadyPenalizedThisCycle);
    }

    member.penalized_this_cycle = true;
    member.balance_owed += pool.penalty_amount;
    member.delinquent = true;
    storage::write_member(env, &member);

    crate::reputation::report_late(env, &member_addr);

    Penalized {
        member: member_addr,
        penalty_amount: pool.penalty_amount,
        balance_owed: member.balance_owed,
    }
    .publish(env);
    Ok(())
}

/// Lets a delinquent member pay down what they owe. Requires the member's
/// own signature, unlike `distribute`/`penalize`, because it moves money
/// OUT of the payer's own account — the one case in this module that
/// genuinely needs an authorized party, not a permissionless trigger.
pub fn pay_debt(env: &Env, member_addr: Address, amount: i128) -> Result<(), Error> {
    member_addr.require_auth();
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let pool = storage::read_pool(env)?;
    let mut member = storage::read_member(env, &member_addr)?;
    if member.balance_owed <= 0 {
        return Err(Error::NoOutstandingDebt);
    }

    // Clamp rather than reject an overpayment attempt: a member offering
    // more than they owe should have the excess simply not collected, not
    // be forced to guess the exact remaining balance first.
    let pay_amount = if amount > member.balance_owed {
        member.balance_owed
    } else {
        amount
    };

    let token_client = token::Client::new(env, &pool.token);
    token_client.transfer(
        &member_addr,
        &MuxedAddress::from(&env.current_contract_address()),
        &pay_amount,
    );

    member.balance_owed -= pay_amount;
    if member.balance_owed == 0 {
        member.delinquent = false;
    }
    storage::write_member(env, &member);

    let mut pool = pool;
    pool.reserve_balance += pay_amount;
    storage::write_pool(env, &pool);

    DebtPaid {
        member: member_addr,
        amount: pay_amount,
    }
    .publish(env);
    Ok(())
}
