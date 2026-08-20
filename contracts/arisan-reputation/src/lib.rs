#![no_std]
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotAuthorized = 1,
}

/// Raw, append-only counts. The score is derived on read rather than
/// stored, so the scoring policy can be retuned after real pilot data
/// without rewriting or corrupting anyone's history, and every score stays
/// auditable from its inputs.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Record {
    pub on_time: u32,
    pub late: u32,
    pub defaulted: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    Writer(Address),
    Record(Address),
}

const BUMP_THRESHOLD: u32 = 17280;
const BUMP_TO: u32 = 518400;

#[contract]
pub struct ArisanReputation;

#[contractimpl]
impl ArisanReputation {
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    pub fn add_writer(env: Env, writer: Address) {
        Self::require_admin(&env);
        env.storage()
            .persistent()
            .set(&DataKey::Writer(writer.clone()), &true);
        env.storage().persistent().extend_ttl(
            &DataKey::Writer(writer),
            BUMP_THRESHOLD,
            BUMP_TO,
        );
    }

    pub fn remove_writer(env: Env, writer: Address) {
        Self::require_admin(&env);
        env.storage().persistent().remove(&DataKey::Writer(writer));
    }

    pub fn is_writer(env: Env, writer: Address) -> bool {
        env.storage().persistent().has(&DataKey::Writer(writer))
    }

    pub fn record_on_time(env: Env, caller: Address, member: Address) -> Result<(), Error> {
        let mut r = Self::authorized_record(&env, caller, &member)?;
        r.on_time += 1;
        Self::write_record(&env, &member, &r);
        Ok(())
    }

    pub fn record_late(env: Env, caller: Address, member: Address) -> Result<(), Error> {
        let mut r = Self::authorized_record(&env, caller, &member)?;
        r.late += 1;
        Self::write_record(&env, &member, &r);
        Ok(())
    }

    pub fn record_default(env: Env, caller: Address, member: Address) -> Result<(), Error> {
        let mut r = Self::authorized_record(&env, caller, &member)?;
        r.defaulted += 1;
        Self::write_record(&env, &member, &r);
        Ok(())
    }

    pub fn record(env: Env, member: Address) -> Record {
        env.storage()
            .persistent()
            .get(&DataKey::Record(member))
            .unwrap_or(Record {
                on_time: 0,
                late: 0,
                defaulted: 0,
            })
    }

    /// score = 100 * on_time / (on_time + 2*late + 5*defaulted + 3)
    ///
    /// A member with no history scores 0, not a neutral middle value:
    /// reputation is earned, never granted, so abandoning a damaged address
    /// for a fresh one forfeits everything and gains nothing. The `+3`
    /// grace term prevents division by zero and stops a single on-time
    /// payment from reading as a perfect score. Because the denominator is
    /// always strictly greater than the numerator's `on_time` term, the
    /// score approaches but never reaches 100 — deliberate; perfect trust
    /// is not attainable.
    ///
    /// Arithmetic is widened to u64: `100 * on_time` overflows u32 for
    /// large counts, and the release profile has overflow-checks on.
    pub fn score(env: Env, member: Address) -> u32 {
        let r = Self::record(env, member);
        let numerator = 100u64 * r.on_time as u64;
        let denominator =
            r.on_time as u64 + 2 * r.late as u64 + 5 * r.defaulted as u64 + 3;
        (numerator / denominator) as u32
    }

    fn require_admin(env: &Env) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
    }

    /// Proves the caller really is who it claims (`require_auth`) and that
    /// it is an allowlisted writer. Without the allowlist any address could
    /// inflate its own score; without `require_auth` any address could
    /// simply name an allowlisted pool as `caller`.
    fn authorized_record(env: &Env, caller: Address, member: &Address) -> Result<Record, Error> {
        caller.require_auth();
        let key = DataKey::Writer(caller);
        if !env.storage().persistent().has(&key) {
            return Err(Error::NotAuthorized);
        }
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        // I6: keep instance storage (Admin) alive on every reporting call.
        env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
        Ok(Self::record(env.clone(), member.clone()))
    }

    fn write_record(env: &Env, member: &Address, r: &Record) {
        let key = DataKey::Record(member.clone());
        env.storage().persistent().set(&key, r);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
    }
}

mod test;
