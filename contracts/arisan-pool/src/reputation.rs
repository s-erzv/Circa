use crate::config;
use crate::events::ReputationWriteFailed;
use soroban_sdk::{contractclient, symbol_short, Address, Env};

/// Interface of the reputation contract. Declared as a trait so the pool
/// needs no dependency on the reputation crate.
///
/// The trait itself is never called through — it exists only so
/// `#[contractclient]` can generate `ReputationClient` (and its `try_*`
/// variants) from these signatures, so `dead_code` flags it. Kept as the
/// single declaration of the reputation ABI the pool depends on.
#[allow(dead_code)]
#[contractclient(name = "ReputationClient")]
pub trait ReputationInterface {
    fn record_on_time(env: Env, caller: Address, member: Address);
    fn record_late(env: Env, caller: Address, member: Address);
    fn record_default(env: Env, caller: Address, member: Address);
}

/// Reporting is a no-op when no reputation contract is configured.
///
/// When one IS configured, failures are **swallowed** rather than propagated:
/// a data-integrity feature (reputation scoring) must never be load-bearing
/// for the pool's core money-moving and governance operations. A stale or
/// broken reputation feed is a lesser problem than an unkickable defaulter
/// or a permanently frozen pool. The `ReputationWriteFailed` event exists
/// precisely so the gap isn't invisible — an indexer or organizer sees the
/// failure and can call `clear_reputation()` to stop the broken feed.
fn client(env: &Env) -> Option<ReputationClient<'_>> {
    config::get_reputation(env).map(|addr| ReputationClient::new(env, &addr))
}

pub fn report_on_time(env: &Env, member: &Address) {
    if let Some(c) = client(env) {
        let ok = c.try_record_on_time(&env.current_contract_address(), member);
        if ok.is_err() {
            ReputationWriteFailed {
                member: member.clone(),
                kind: symbol_short!("on_time"),
            }
            .publish(env);
        }
    }
}

pub fn report_late(env: &Env, member: &Address) {
    if let Some(c) = client(env) {
        let ok = c.try_record_late(&env.current_contract_address(), member);
        if ok.is_err() {
            ReputationWriteFailed {
                member: member.clone(),
                kind: symbol_short!("late"),
            }
            .publish(env);
        }
    }
}

pub fn report_default(env: &Env, member: &Address) {
    if let Some(c) = client(env) {
        let ok = c.try_record_default(&env.current_contract_address(), member);
        if ok.is_err() {
            ReputationWriteFailed {
                member: member.clone(),
                kind: symbol_short!("default"),
            }
            .publish(env);
        }
    }
}
