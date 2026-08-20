use crate::types::{DataKey, Error, Member, Pool};
use soroban_sdk::{Address, Env};

pub const BUMP_THRESHOLD: u32 = 17280; // ~1 day at 5s/ledger
pub const BUMP_TO: u32 = 518400; // ~30 days at 5s/ledger

pub fn has_pool(env: &Env) -> bool {
    env.storage().persistent().has(&DataKey::Pool)
}

pub fn read_pool(env: &Env) -> Result<Pool, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Pool)
        .ok_or(Error::PoolNotFound)
}

pub fn write_pool(env: &Env, pool: &Pool) {
    env.storage().persistent().set(&DataKey::Pool, pool);
    env.storage()
        .persistent()
        .extend_ttl(&DataKey::Pool, BUMP_THRESHOLD, BUMP_TO);
}

pub fn read_member(env: &Env, addr: &Address) -> Result<Member, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Member(addr.clone()))
        .ok_or(Error::MemberNotFound)
}

pub fn write_member(env: &Env, member: &Member) {
    let key = DataKey::Member(member.address.clone());
    env.storage().persistent().set(&key, member);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
}
