#![cfg(test)]

use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::Env;

fn setup(env: &Env) -> (ArisanReputationClient<'static>, Address, Address) {
    let admin = Address::generate(env);
    let id = env.register(ArisanReputation, (admin.clone(),));
    let client = ArisanReputationClient::new(env, &id);
    let pool = Address::generate(env);
    (client, admin, pool)
}

#[test]
fn test_unknown_member_scores_zero() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _pool) = setup(&env);

    let m = Address::generate(&env);
    assert_eq!(client.score(&m), 0);
    let r = client.record(&m);
    assert_eq!(r.on_time, 0);
    assert_eq!(r.late, 0);
    assert_eq!(r.defaulted, 0);
}

#[test]
fn test_score_formula_exact_values() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, pool) = setup(&env);
    client.add_writer(&pool);

    let m = Address::generate(&env);
    // 4 on-time, 1 late, 0 defaulted:
    // score = 100*4 / (4 + 2*1 + 5*0 + 3) = 400/9 = 44 (integer division)
    for _ in 0..4 {
        client.record_on_time(&pool, &m);
    }
    client.record_late(&pool, &m);
    assert_eq!(client.score(&m), 44);
}

#[test]
fn test_default_weighs_more_than_late() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, pool) = setup(&env);
    client.add_writer(&pool);

    let late_member = Address::generate(&env);
    client.record_on_time(&pool, &late_member);
    client.record_late(&pool, &late_member);
    // score = 100*1 / (1 + 2*1 + 0 + 3) = 100/6 = 16

    let defaulted_member = Address::generate(&env);
    client.record_on_time(&pool, &defaulted_member);
    client.record_default(&pool, &defaulted_member);
    // score = 100*1 / (1 + 0 + 5*1 + 3) = 100/9 = 11

    let late_score = client.score(&late_member);
    let defaulted_score = client.score(&defaulted_member);
    assert_eq!(late_score, 16);
    assert_eq!(defaulted_score, 11);
    assert!(
        defaulted_score < late_score,
        "one default must cost more than one late, for the same on-time count"
    );
}

#[test]
fn test_non_allowlisted_caller_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _pool) = setup(&env);

    let attacker = Address::generate(&env);
    let m = Address::generate(&env);
    let res = client.try_record_on_time(&attacker, &m);
    assert_eq!(res, Err(Ok(Error::NotAuthorized)));
    assert_eq!(client.score(&m), 0);
}

#[test]
fn test_add_writer_is_admin_only() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let id = env.register(ArisanReputation, (admin.clone(),));
    let client = ArisanReputationClient::new(&env, &id);

    let attacker = Address::generate(&env);

    // `attacker` authorizes the call, but it is not the admin.
    let res = client
        .mock_auths(&[MockAuth {
            address: &attacker,
            invoke: &MockAuthInvoke {
                contract: &id,
                fn_name: "add_writer",
                args: (attacker.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_add_writer(&attacker);

    assert!(
        res.is_err(),
        "a non-admin must not be able to allowlist itself as a writer"
    );
    assert!(!client.is_writer(&attacker));
}

/// `add_writer`'s admin guard had a scoped-auth test; `remove_writer`'s did
/// not, even though revoking a writer is the more damaging direction — it is
/// what stops a live pool's reputation feed. Without this, `require_admin`
/// could be deleted from `remove_writer` alone and the whole suite would
/// stay green.
///
/// Both halves matter: the negative case alone would also pass if
/// `remove_writer` were broken for *everyone*, so the positive control
/// proves the rejection came from the admin check specifically and not from
/// some unrelated precondition.
#[test]
fn test_remove_writer_is_admin_only() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let id = env.register(ArisanReputation, (admin.clone(),));
    let client = ArisanReputationClient::new(&env, &id);
    let pool = Address::generate(&env);

    // Admin allowlists the pool as a writer.
    client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &id,
                fn_name: "add_writer",
                args: (pool.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .add_writer(&pool);
    assert!(client.is_writer(&pool));

    // Negative case: a non-admin authorizes the call, but is not the admin.
    let attacker = Address::generate(&env);
    let res = client
        .mock_auths(&[MockAuth {
            address: &attacker,
            invoke: &MockAuthInvoke {
                contract: &id,
                fn_name: "remove_writer",
                args: (pool.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_remove_writer(&pool);

    assert!(
        res.is_err(),
        "a non-admin must not be able to revoke a writer — doing so would \
         let anyone sever a live pool's reputation feed"
    );
    assert!(
        client.is_writer(&pool),
        "the writer must survive a rejected removal"
    );

    // Positive control: the admin CAN remove it, proving the rejection above
    // came from the admin check and not from an unrelated precondition.
    client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &id,
                fn_name: "remove_writer",
                args: (pool.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .remove_writer(&pool);
    assert!(!client.is_writer(&pool));
}

#[test]
fn test_remove_writer_revokes_access() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, pool) = setup(&env);
    client.add_writer(&pool);

    let m = Address::generate(&env);
    client.record_on_time(&pool, &m);
    assert!(client.is_writer(&pool));

    client.remove_writer(&pool);
    assert!(!client.is_writer(&pool));

    let res = client.try_record_on_time(&pool, &m);
    assert_eq!(res, Err(Ok(Error::NotAuthorized)));
    // The already-recorded history survives revocation.
    assert_eq!(client.record(&m).on_time, 1);
}

use soroban_sdk::testutils::MockAuth;
use soroban_sdk::testutils::MockAuthInvoke;
use soroban_sdk::IntoVal;

#[test]
fn test_writer_auth_is_actually_enforced() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let id = env.register(ArisanReputation, (admin.clone(),));
    let client = ArisanReputationClient::new(&env, &id);
    let pool = Address::generate(&env);
    let m = Address::generate(&env);

    client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &id,
                fn_name: "add_writer",
                args: (pool.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .add_writer(&pool);

    // Someone else authorizes the call, claiming `pool` as the caller
    // argument — `caller.require_auth()` must reject this, because the
    // party that actually signed is not `pool`.
    let impersonator = Address::generate(&env);
    let res = client
        .mock_auths(&[MockAuth {
            address: &impersonator,
            invoke: &MockAuthInvoke {
                contract: &id,
                fn_name: "record_on_time",
                args: (pool.clone(), m.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_record_on_time(&pool, &m);

    assert!(
        res.is_err(),
        "record_on_time must fail when `pool` itself did not authorize the call"
    );
    assert_eq!(client.score(&m), 0);
}
