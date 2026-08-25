#![cfg(test)]

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};
use soroban_sdk::{Env, IntoVal};

fn setup_pool_with_token(
    env: &Env,
) -> (ArisanPoolClient<'_>, Address, Address, StellarAssetClient<'static>) {
    let pool_id = env.register(ArisanPool, ());
    let client = ArisanPoolClient::new(env, &pool_id);

    let organizer = Address::generate(env);
    let token_admin = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(token_admin);
    let token = sac.address();
    let asset_client = StellarAssetClient::new(env, &token);

    (client, organizer, token, asset_client)
}

/// Returns the freshly generated `gateway` address the pool was created
/// with, for the handful of tests that need to sign as it
/// (`contribute_via_gateway`) — every other call site just ignores the
/// return value, same as it ignored nothing before this existed.
fn create_default_pool(
    env: &Env,
    client: &ArisanPoolClient,
    organizer: &Address,
    token: &Address,
    member_count: u32,
) -> Address {
    let gateway = Address::generate(env);
    client.create(
        organizer,
        token,
        &gateway,
        &100i128,
        &member_count,
        &2_592_000u64, // 30 days
        &259_200u64,   // 3 days
        &10i128,
        &5i128,
        &0u32,
    );
    gateway
}

fn join_all(env: &Env, client: &ArisanPoolClient, n: u32) -> soroban_sdk::Vec<Address> {
    let mut members = soroban_sdk::Vec::new(env);
    for _ in 0..n {
        let m = Address::generate(env);
        client.join(&m);
        members.push_back(m);
    }
    members
}

// ---------- create() ----------

#[test]
fn test_create_rejects_invalid_amounts() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, _asset) = setup_pool_with_token(&env);
    let gateway = Address::generate(&env);

    assert_eq!(
        client.try_create(
            &organizer, &token, &gateway, &0i128, &3u32, &2_592_000u64, &259_200u64, &10i128,
            &5i128, &0u32,
        ),
        Err(Ok(Error::InvalidAmount)),
        "contribution_amount must be positive"
    );
    assert_eq!(
        client.try_create(
            &organizer, &token, &gateway, &100i128, &1u32, &2_592_000u64, &259_200u64, &10i128,
            &5i128, &0u32,
        ),
        Err(Ok(Error::InvalidAmount)),
        "member_count below 2 makes no sense as a rotating pool"
    );
    assert_eq!(
        client.try_create(
            &organizer, &token, &gateway, &100i128, &3u32, &0u64, &259_200u64, &10i128, &5i128,
            &0u32,
        ),
        Err(Ok(Error::InvalidAmount)),
        "zero cycle_length_secs would collapse the deadline gate"
    );
    assert_eq!(
        client.try_create(
            &organizer, &token, &gateway, &100i128, &3u32, &2_592_000u64, &0u64, &10i128, &5i128,
            &0u32,
        ),
        Err(Ok(Error::InvalidAmount)),
        "zero deadline_offset_secs would collapse the deadline gate"
    );
    assert_eq!(
        client.try_create(
            &organizer,
            &token,
            &gateway,
            &100i128,
            &3u32,
            &2_592_000u64,
            &259_200u64,
            &10i128,
            &5i128,
            &(MAX_RESERVE_BPS + 1),
        ),
        Err(Ok(Error::InvalidAmount)),
        "reserve_bps above the cap is rejected, not silently clamped"
    );
}

#[test]
fn test_create_twice_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, _asset) = setup_pool_with_token(&env);
    let gateway = create_default_pool(&env, &client, &organizer, &token, 3);

    assert_eq!(
        client.try_create(
            &organizer, &token, &gateway, &100i128, &3u32, &2_592_000u64, &259_200u64, &10i128,
            &5i128, &0u32,
        ),
        Err(Ok(Error::PoolAlreadyExists))
    );
}

// ---------- join() / activation ----------

#[test]
fn test_join_fills_and_activates_pool() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, _asset) = setup_pool_with_token(&env);
    create_default_pool(&env, &client, &organizer, &token, 3);

    assert!(!client.get_pool().activated);
    let members = join_all(&env, &client, 3);

    let pool = client.get_pool();
    assert!(pool.activated);
    assert_eq!(pool.queue.len(), 3);
    for m in members.iter() {
        assert!(pool.queue.contains(&m));
    }
    // cycle_deadline is set from deadline_offset_secs (the grace window),
    // not cycle_length_secs — confirmed against the live deployed contract
    // during reconstruction, not assumed.
    assert_eq!(pool.cycle_deadline, env.ledger().timestamp() + 259_200);
}

#[test]
fn test_join_rejects_duplicate_and_full_pool() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, _asset) = setup_pool_with_token(&env);
    create_default_pool(&env, &client, &organizer, &token, 2);

    let m1 = Address::generate(&env);
    client.join(&m1);
    assert_eq!(client.try_join(&m1), Err(Ok(Error::AlreadyJoined)));

    let m2 = Address::generate(&env);
    client.join(&m2);
    assert!(client.get_pool().activated);

    let m3 = Address::generate(&env);
    assert_eq!(client.try_join(&m3), Err(Ok(Error::PoolFull)));
}

#[test]
fn test_join_requires_member_auth() {
    let env = Env::default();
    let (client, organizer, token, _asset) = setup_pool_with_token(&env);
    env.mock_all_auths();
    create_default_pool(&env, &client, &organizer, &token, 2);

    let m1 = Address::generate(&env);
    let impostor = Address::generate(&env);
    let res = client
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &impostor,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &client.address,
                fn_name: "join",
                args: (m1.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_join(&m1);
    assert!(res.is_err(), "someone else authorizing cannot join on m1's behalf");
    assert!(!client.get_pool().members.contains(&m1));
}

// ---------- contribute() ----------

#[test]
fn test_contribute_before_activation_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, asset) = setup_pool_with_token(&env);
    create_default_pool(&env, &client, &organizer, &token, 3);
    let m1 = Address::generate(&env);
    client.join(&m1);
    asset.mint(&m1, &1000i128);

    assert_eq!(client.try_contribute(&m1), Err(Ok(Error::PoolNotActivated)));
}

#[test]
fn test_contribute_moves_tokens_and_marks_on_time() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, asset) = setup_pool_with_token(&env);
    create_default_pool(&env, &client, &organizer, &token, 2);
    let members = join_all(&env, &client, 2);
    let m1 = members.get_unchecked(0);
    asset.mint(&m1, &1000i128);

    let token_client = TokenClient::new(&env, &token);
    client.contribute(&m1);

    assert_eq!(token_client.balance(&m1), 900);
    assert_eq!(token_client.balance(&client.address), 100);
    let member = client.get_member(&m1);
    assert!(member.contributed_this_cycle);
    assert_eq!(member.total_contributed, 100);
    assert_eq!(client.get_pool().cycle_pot, 100);
}

#[test]
fn test_contribute_twice_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, asset) = setup_pool_with_token(&env);
    create_default_pool(&env, &client, &organizer, &token, 2);
    let members = join_all(&env, &client, 2);
    let m1 = members.get_unchecked(0);
    asset.mint(&m1, &1000i128);

    client.contribute(&m1);
    assert_eq!(client.try_contribute(&m1), Err(Ok(Error::AlreadyContributed)));
}

// ---------- contribute_via_gateway() ----------

#[test]
fn test_contribute_via_gateway_moves_tokens_from_gateway_not_member() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, asset) = setup_pool_with_token(&env);
    let gateway = create_default_pool(&env, &client, &organizer, &token, 2);
    let members = join_all(&env, &client, 2);
    let m1 = members.get_unchecked(0);
    asset.mint(&gateway, &1000i128);

    let token_client = TokenClient::new(&env, &token);
    client.contribute_via_gateway(&m1);

    // The member's own wallet is never touched — this is exactly the point:
    // a member with zero balance can still be credited, because the QRIS
    // payment already moved real value into the gateway's account, not
    // theirs.
    assert_eq!(token_client.balance(&m1), 0);
    assert_eq!(token_client.balance(&gateway), 900);
    assert_eq!(token_client.balance(&client.address), 100);
    let member = client.get_member(&m1);
    assert!(member.contributed_this_cycle);
    assert_eq!(member.total_contributed, 100);
    assert_eq!(client.get_pool().cycle_pot, 100);
}

#[test]
fn test_contribute_via_gateway_rejects_wrong_authorizer() {
    let env = Env::default();
    let (client, organizer, token, asset) = setup_pool_with_token(&env);
    env.mock_all_auths();
    let gateway = create_default_pool(&env, &client, &organizer, &token, 2);
    let members = join_all(&env, &client, 2);
    let m1 = members.get_unchecked(0);
    asset.mint(&gateway, &1000i128);

    let impostor = Address::generate(&env);
    let res = client
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &impostor,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &client.address,
                fn_name: "contribute_via_gateway",
                args: (m1.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_contribute_via_gateway(&m1);
    assert!(res.is_err(), "an address other than the configured gateway cannot credit a contribution");
    assert!(!client.get_member(&m1).contributed_this_cycle);
}

#[test]
fn test_contribute_via_gateway_rejects_member_self_authorizing() {
    // The member authorizing their OWN gateway-credit (instead of the
    // gateway itself) must also fail — this is the specific case that
    // would let a member forge a "someone paid for me" credit for free,
    // without any real transfer happening, since a member always CAN
    // authorize actions concerning themselves.
    let env = Env::default();
    let (client, organizer, token, asset) = setup_pool_with_token(&env);
    env.mock_all_auths();
    let gateway = create_default_pool(&env, &client, &organizer, &token, 2);
    let members = join_all(&env, &client, 2);
    let m1 = members.get_unchecked(0);
    asset.mint(&gateway, &1000i128);

    let res = client
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &m1,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &client.address,
                fn_name: "contribute_via_gateway",
                args: (m1.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_contribute_via_gateway(&m1);
    assert!(res.is_err(), "a member cannot self-authorize their own gateway credit");
    assert!(!client.get_member(&m1).contributed_this_cycle);
}

#[test]
fn test_contribute_via_gateway_twice_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, asset) = setup_pool_with_token(&env);
    let gateway = create_default_pool(&env, &client, &organizer, &token, 2);
    let members = join_all(&env, &client, 2);
    let m1 = members.get_unchecked(0);
    asset.mint(&gateway, &1000i128);

    client.contribute_via_gateway(&m1);
    assert_eq!(
        client.try_contribute_via_gateway(&m1),
        Err(Ok(Error::AlreadyContributed))
    );
}

// ---------- distribute() / penalize() ----------

#[test]
fn test_distribute_before_deadline_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, asset) = setup_pool_with_token(&env);
    create_default_pool(&env, &client, &organizer, &token, 2);
    let members = join_all(&env, &client, 2);
    for m in members.iter() {
        asset.mint(&m, &1000i128);
        client.contribute(&m);
    }
    assert_eq!(client.try_distribute(), Err(Ok(Error::DeadlineNotPassed)));
}

#[test]
fn test_distribute_pays_queue_front_and_advances_cycle() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, asset) = setup_pool_with_token(&env);
    create_default_pool(&env, &client, &organizer, &token, 2);
    let members = join_all(&env, &client, 2);
    for m in members.iter() {
        asset.mint(&m, &1000i128);
        client.contribute(&m);
    }

    let recipient = client.get_pool().queue.get_unchecked(0);
    let token_client = TokenClient::new(&env, &token);
    let balance_before = token_client.balance(&recipient);

    env.ledger().set_timestamp(env.ledger().timestamp() + 259_200 + 1);
    client.distribute();

    // gross = 200, skim = 0 (reserve_bps = 0), net_payout = 200.
    assert_eq!(token_client.balance(&recipient), balance_before + 200);
    assert!(client.get_member(&recipient).received_payout);

    let pool_after = client.get_pool();
    assert_eq!(pool_after.current_cycle, 1);
    assert_eq!(pool_after.cycle_pot, 0);
    assert_eq!(pool_after.queue.len(), 1);
    assert!(!pool_after.queue.contains(&recipient));
}

#[test]
fn test_distribute_is_permissionless() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, asset) = setup_pool_with_token(&env);
    create_default_pool(&env, &client, &organizer, &token, 2);
    let members = join_all(&env, &client, 2);
    for m in members.iter() {
        asset.mint(&m, &1000i128);
        client.contribute(&m);
    }
    env.ledger().set_timestamp(env.ledger().timestamp() + 259_200 + 1);

    // Called with NO auths mocked at all — distribute() must not require
    // require_auth() from anyone, or an outsider could never trigger a
    // payout the members themselves forgot to.
    env.set_auths(&[]);
    let res = client.try_distribute();
    assert!(res.is_ok(), "distribute() must be callable with zero authorizations");
}

#[test]
fn test_distribute_splits_leftover_reserve_among_members_on_close() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, asset) = setup_pool_with_token(&env);
    let gateway = Address::generate(&env);

    // reserve_bps = 500 (5%), unlike create_default_pool's 0 — needed to
    // actually accumulate something in reserve_balance to distribute.
    client.create(
        &organizer, &token, &gateway, &100i128, &2u32, &2_592_000u64, &259_200u64, &10i128,
        &5i128, &500u32,
    );
    let members = join_all(&env, &client, 2);
    let token_client = TokenClient::new(&env, &token);

    // Cycle 1: ordinary distribute, not the closing one.
    for m in members.iter() {
        asset.mint(&m, &1000i128);
        client.contribute(&m);
    }
    env.ledger().set_timestamp(env.ledger().timestamp() + 259_200 + 1);
    client.distribute();
    assert_eq!(client.get_pool().reserve_balance, 10, "5% skim of the 200 gross pot");

    // Cycle 2: the closing distribute. Capture balances immediately before
    // so the assertions below are exact deltas, not confused by the 1000
    // re-mint each member also receives this round.
    for m in members.iter() {
        if !client.get_member(&m).contributed_this_cycle {
            asset.mint(&m, &1000i128);
            client.contribute(&m);
        }
    }
    env.ledger().set_timestamp(env.ledger().timestamp() + 259_200 + 1);
    let m0 = members.get_unchecked(0);
    let m1 = members.get_unchecked(1);
    let before0 = token_client.balance(&m0);
    let before1 = token_client.balance(&m1);
    client.distribute();

    let pool = client.get_pool();
    assert!(pool.closed);
    // Second skim (another 10) brings reserve to 20 before the close-split;
    // split 2 ways with no remainder leaves reserve_balance at exactly 0.
    assert_eq!(pool.reserve_balance, 0, "evenly split — no dust left for 20/2");

    // Exactly one member received this cycle's net payout (190) + the 10
    // reserve share = 200; the other received only their 10 reserve share
    // (their own payout already happened in cycle 1).
    let d0 = token_client.balance(&m0) - before0;
    let d1 = token_client.balance(&m1) - before1;
    assert!(
        (d0 == 200 && d1 == 10) || (d0 == 10 && d1 == 200),
        "one member got payout+reserve (200), the other got just their reserve share (10): {d0}, {d1}"
    );
}

#[test]
fn test_distribute_closes_pool_when_queue_empties() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, asset) = setup_pool_with_token(&env);
    create_default_pool(&env, &client, &organizer, &token, 2);
    let members = join_all(&env, &client, 2);

    for _ in 0..2 {
        for m in members.iter() {
            if !client.get_member(&m).contributed_this_cycle && !client.get_member(&m).exited {
                asset.mint(&m, &1000i128);
                let _ = client.try_contribute(&m);
            }
        }
        env.ledger().set_timestamp(env.ledger().timestamp() + 259_200 + 1);
        client.distribute();
    }

    assert!(client.get_pool().closed);
}

#[test]
fn test_penalize_marks_delinquent_and_owed() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, asset) = setup_pool_with_token(&env);
    create_default_pool(&env, &client, &organizer, &token, 2);
    let members = join_all(&env, &client, 2);
    let m1 = members.get_unchecked(0);
    let _ = asset;

    env.ledger().set_timestamp(env.ledger().timestamp() + 259_200 + 1);
    assert_eq!(client.try_penalize(&m1), Ok(Ok(())));

    let member = client.get_member(&m1);
    assert!(member.delinquent);
    assert_eq!(member.balance_owed, 10);
    assert_eq!(
        client.try_penalize(&m1),
        Err(Ok(Error::AlreadyPenalizedThisCycle))
    );
}

// ---------- pay_debt() ----------

#[test]
fn test_pay_debt_requires_own_auth_and_clears_delinquent() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, asset) = setup_pool_with_token(&env);
    create_default_pool(&env, &client, &organizer, &token, 2);
    let members = join_all(&env, &client, 2);
    let m1 = members.get_unchecked(0);

    env.ledger().set_timestamp(env.ledger().timestamp() + 259_200 + 1);
    client.penalize(&m1);
    assert_eq!(client.get_member(&m1).balance_owed, 10);

    asset.mint(&m1, &1000i128);
    assert_eq!(client.try_pay_debt(&m1, &0i128), Err(Ok(Error::InvalidAmount)));

    client.pay_debt(&m1, &10i128);
    let member = client.get_member(&m1);
    assert_eq!(member.balance_owed, 0);
    assert!(!member.delinquent);
}

#[test]
fn test_pay_debt_clamps_overpayment() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, asset) = setup_pool_with_token(&env);
    create_default_pool(&env, &client, &organizer, &token, 2);
    let members = join_all(&env, &client, 2);
    let m1 = members.get_unchecked(0);

    env.ledger().set_timestamp(env.ledger().timestamp() + 259_200 + 1);
    client.penalize(&m1);
    asset.mint(&m1, &1000i128);

    let token_client = TokenClient::new(&env, &token);
    let before = token_client.balance(&m1);
    client.pay_debt(&m1, &1000i128); // owes only 10
    assert_eq!(token_client.balance(&m1), before - 10);
    assert_eq!(client.get_member(&m1).balance_owed, 0);
}

// ---------- exit() ----------

#[test]
fn test_exit_refunds_current_cycle_minus_penalty() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, asset) = setup_pool_with_token(&env);
    create_default_pool(&env, &client, &organizer, &token, 3);
    let members = join_all(&env, &client, 3);
    let m1 = members.get_unchecked(0);
    asset.mint(&m1, &1000i128);
    client.contribute(&m1);

    let token_client = TokenClient::new(&env, &token);
    let before = token_client.balance(&m1);
    client.exit(&m1);
    // contribution 100 - exit_penalty 5 = 95 refunded.
    assert_eq!(token_client.balance(&m1), before + 95);
    assert!(client.get_member(&m1).exited);
    assert!(!client.get_pool().members.contains(&m1));
    assert!(!client.get_pool().queue.contains(&m1));
}

#[test]
fn test_exit_blocked_by_outstanding_debt_after_payout() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, asset) = setup_pool_with_token(&env);
    create_default_pool(&env, &client, &organizer, &token, 2);
    let members = join_all(&env, &client, 2);
    for m in members.iter() {
        asset.mint(&m, &1000i128);
        client.contribute(&m);
    }
    let recipient = client.get_pool().queue.get_unchecked(0);
    env.ledger().set_timestamp(env.ledger().timestamp() + 259_200 + 1);
    client.distribute();
    assert!(client.get_member(&recipient).received_payout);

    // Force the recipient into debt post-payout via a second missed cycle.
    env.ledger().set_timestamp(env.ledger().timestamp() + 259_200 + 1);
    let _ = client.try_penalize(&recipient);
    if client.get_member(&recipient).balance_owed > 0 {
        assert_eq!(client.try_exit(&recipient), Err(Ok(Error::OutstandingDebt)));
    }
}

#[test]
fn test_exit_twice_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, _asset) = setup_pool_with_token(&env);
    create_default_pool(&env, &client, &organizer, &token, 3);
    let members = join_all(&env, &client, 3);
    let m1 = members.get_unchecked(0);
    client.exit(&m1);
    assert_eq!(client.try_exit(&m1), Err(Ok(Error::AlreadyExited)));
}

// ---------- set_gov / set_reputation / clear_reputation ----------

#[test]
fn test_set_gov_requires_organizer_auth() {
    let env = Env::default();
    let (client, organizer, token, _asset) = setup_pool_with_token(&env);
    env.mock_all_auths();
    create_default_pool(&env, &client, &organizer, &token, 3);

    let gov = Address::generate(&env);
    let attacker = Address::generate(&env);
    let res = client
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &attacker,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &client.address,
                fn_name: "set_gov",
                args: (gov.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_set_gov(&gov);
    assert!(res.is_err());
    assert_eq!(client.get_gov(), None);

    client.set_gov(&gov);
    assert_eq!(client.get_gov(), Some(gov));
}

#[test]
fn test_set_gov_blocked_after_activation_and_single_shot() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, _asset) = setup_pool_with_token(&env);
    create_default_pool(&env, &client, &organizer, &token, 2);

    let gov1 = Address::generate(&env);
    client.set_gov(&gov1);
    let gov2 = Address::generate(&env);
    assert_eq!(client.try_set_gov(&gov2), Err(Ok(Error::AlreadyConfigured)));

    join_all(&env, &client, 2);
    let gov3 = Address::generate(&env);
    let (client2, organizer2, token2, _a2) = setup_pool_with_token(&env);
    create_default_pool(&env, &client2, &organizer2, &token2, 2);
    join_all(&env, &client2, 2);
    assert_eq!(
        client2.try_set_gov(&gov3),
        Err(Ok(Error::PoolAlreadyActivated))
    );
}

#[test]
fn test_clear_reputation_is_organizer_only_and_not_activation_gated() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, _asset) = setup_pool_with_token(&env);
    create_default_pool(&env, &client, &organizer, &token, 2);

    let reputation = Address::generate(&env);
    client.set_reputation(&reputation);
    join_all(&env, &client, 2); // activates
    assert_eq!(client.get_reputation(), Some(reputation));

    let attacker = Address::generate(&env);
    let res = client
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &attacker,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &client.address,
                fn_name: "clear_reputation",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_clear_reputation();
    assert!(res.is_err());

    // Organizer CAN clear post-activation — the escape hatch this exists for.
    client.clear_reputation();
    assert_eq!(client.get_reputation(), None);
}

// ---------- gov_skip / gov_kick ----------

#[test]
fn test_gov_ops_require_configured_gov() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, _asset) = setup_pool_with_token(&env);
    create_default_pool(&env, &client, &organizer, &token, 2);
    let members = join_all(&env, &client, 2);
    let m1 = members.get_unchecked(0);

    assert_eq!(client.try_gov_skip(&m1), Err(Ok(Error::GovNotConfigured)));
    assert_eq!(client.try_gov_kick(&m1), Err(Ok(Error::GovNotConfigured)));
}

#[test]
fn test_only_configured_gov_can_drive_pool_ops() {
    let env = Env::default();
    let (client, organizer, token, _asset) = setup_pool_with_token(&env);
    env.mock_all_auths();
    create_default_pool(&env, &client, &organizer, &token, 2);
    client.set_gov(&organizer); // pretend organizer address IS gov, pre-activation
    let members = join_all(&env, &client, 2);
    let m1 = members.get_unchecked(0);

    let impostor = Address::generate(&env);
    let res = client
        .mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &impostor,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &client.address,
                fn_name: "gov_skip",
                args: (m1.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_gov_skip(&m1);
    assert!(res.is_err(), "only the configured gov address may drive gov_skip");
    assert!(client.get_pool().queue.contains(&m1));

    // Positive control: the real configured gov CAN drive it.
    client.gov_skip(&m1);
}

#[test]
fn test_gov_kick_reports_default_only_when_balance_owed() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, _asset) = setup_pool_with_token(&env);
    create_default_pool(&env, &client, &organizer, &token, 2);

    let rep_admin = Address::generate(&env);
    let rep_id = env.register(arisan_reputation::ArisanReputation, (rep_admin.clone(),));
    let rep_client = arisan_reputation::ArisanReputationClient::new(&env, &rep_id);
    rep_client.add_writer(&client.address);

    client.set_gov(&organizer);
    client.set_reputation(&rep_id);
    let members = join_all(&env, &client, 2);
    let m1 = members.get_unchecked(0);

    // m1 owes nothing: kicked, no default recorded.
    client.gov_kick(&m1);
    assert_eq!(rep_client.record(&m1).defaulted, 0);
    assert!(client.get_member(&m1).exited);

    // m2: force balance_owed via a missed cycle, then kick.
    let m2 = members.get_unchecked(1);
    env.ledger().set_timestamp(env.ledger().timestamp() + 259_200 + 1);
    let _ = client.try_penalize(&m2);
    assert!(client.get_member(&m2).balance_owed > 0);
    client.gov_kick(&m2);
    assert_eq!(rep_client.record(&m2).defaulted, 1);
}

#[test]
fn test_gov_ops_rejected_on_closed_pool() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, asset) = setup_pool_with_token(&env);
    create_default_pool(&env, &client, &organizer, &token, 2);
    client.set_gov(&organizer);
    let members = join_all(&env, &client, 2);

    for _ in 0..2 {
        for m in members.iter() {
            if !client.get_member(&m).contributed_this_cycle && !client.get_member(&m).exited {
                asset.mint(&m, &1000i128);
                let _ = client.try_contribute(&m);
            }
        }
        env.ledger().set_timestamp(env.ledger().timestamp() + 259_200 + 1);
        client.distribute();
    }
    assert!(client.get_pool().closed);

    let m1 = members.get_unchecked(0);
    assert_eq!(client.try_gov_kick(&m1), Err(Ok(Error::PoolClosed)));
    assert_eq!(client.try_gov_skip(&m1), Err(Ok(Error::PoolClosed)));
}

// ---------- request_swap / accept_swap ----------

#[test]
fn test_swap_requires_mutual_consent() {
    let env = Env::default();
    let (client, organizer, token, _asset) = setup_pool_with_token(&env);
    env.mock_all_auths();
    create_default_pool(&env, &client, &organizer, &token, 3);
    let members = join_all(&env, &client, 3);
    let m1 = members.get_unchecked(0);
    let m2 = members.get_unchecked(1);

    let pos_m1_before = client.get_pool().queue.first_index_of(&m1).unwrap();
    let pos_m2_before = client.get_pool().queue.first_index_of(&m2).unwrap();

    client.request_swap(&m1, &m2);
    // Wrong requester in accept_swap must fail.
    let m3 = members.get_unchecked(2);
    assert_eq!(
        client.try_accept_swap(&m2, &m3),
        Err(Ok(Error::SwapTargetMismatch))
    );
    // Queue unchanged by the rejected attempt.
    assert_eq!(client.get_pool().queue.first_index_of(&m1).unwrap(), pos_m1_before);

    client.accept_swap(&m2, &m1);
    assert_eq!(client.get_pool().queue.first_index_of(&m1).unwrap(), pos_m2_before);
    assert_eq!(client.get_pool().queue.first_index_of(&m2).unwrap(), pos_m1_before);
}

#[test]
fn test_accept_swap_without_request_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, _asset) = setup_pool_with_token(&env);
    create_default_pool(&env, &client, &organizer, &token, 3);
    let members = join_all(&env, &client, 3);
    let m1 = members.get_unchecked(0);
    let m2 = members.get_unchecked(1);

    assert_eq!(
        client.try_accept_swap(&m2, &m1),
        Err(Ok(Error::NoPendingSwap))
    );
}

// ---------- on-time / late reputation reporting ----------

#[test]
fn test_on_time_contribution_is_recorded() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, asset) = setup_pool_with_token(&env);
    create_default_pool(&env, &client, &organizer, &token, 2);

    let rep_admin = Address::generate(&env);
    let rep_id = env.register(arisan_reputation::ArisanReputation, (rep_admin.clone(),));
    let rep_client = arisan_reputation::ArisanReputationClient::new(&env, &rep_id);
    rep_client.add_writer(&client.address);
    client.set_reputation(&rep_id);

    let members = join_all(&env, &client, 2);
    let m1 = members.get_unchecked(0);
    asset.mint(&m1, &1000i128);
    client.contribute(&m1);

    assert_eq!(rep_client.record(&m1).on_time, 1);
}

#[test]
fn test_penalize_records_late_once_not_twice() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, asset) = setup_pool_with_token(&env);
    create_default_pool(&env, &client, &organizer, &token, 2);

    let rep_admin = Address::generate(&env);
    let rep_id = env.register(arisan_reputation::ArisanReputation, (rep_admin.clone(),));
    let rep_client = arisan_reputation::ArisanReputationClient::new(&env, &rep_id);
    rep_client.add_writer(&client.address);
    client.set_reputation(&rep_id);

    let members = join_all(&env, &client, 2);
    let m1 = members.get_unchecked(0);

    env.ledger().set_timestamp(env.ledger().timestamp() + 259_200 + 1);
    client.penalize(&m1);
    assert_eq!(rep_client.record(&m1).late, 1);

    asset.mint(&m1, &1000i128);
    client.contribute(&m1);
    // Already penalized this cycle — contribute() must not double-count
    // the same lapse as a second late.
    assert_eq!(rep_client.record(&m1).late, 1);
}

#[test]
fn test_contribute_survives_revoked_reputation_writer() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, asset) = setup_pool_with_token(&env);
    create_default_pool(&env, &client, &organizer, &token, 2);

    let rep_admin = Address::generate(&env);
    let rep_id = env.register(arisan_reputation::ArisanReputation, (rep_admin.clone(),));
    let rep_client = arisan_reputation::ArisanReputationClient::new(&env, &rep_id);
    // Deliberately never add the pool as a writer — every reputation write
    // will fail. contribute() must not revert because of it (C1a).
    let _ = rep_client;
    client.set_reputation(&rep_id);

    let members = join_all(&env, &client, 2);
    let m1 = members.get_unchecked(0);
    asset.mint(&m1, &1000i128);

    let res = client.try_contribute(&m1);
    assert!(
        res.is_ok(),
        "a broken reputation feed must never block contribute()"
    );
}

// ---------- priority swap ----------

#[test]
fn test_priority_swap_second_request_to_same_target_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, asset) = setup_pool_with_token(&env);
    create_default_pool(&env, &client, &organizer, &token, 3);
    let members = join_all(&env, &client, 3);
    let pool = client.get_pool();
    let target = pool.queue.get_unchecked(0);
    let requester1 = pool.queue.get_unchecked(1);
    let requester2 = pool.queue.get_unchecked(2);
    let _ = members;
    asset.mint(&requester1, &1000i128);

    client.request_priority_swap(&requester1, &target, &50i128);
    // A second, different requester targeting the same person must not
    // silently replace the first pending request — the first requester
    // would have no way to know their offer vanished.
    assert_eq!(
        client.try_request_priority_swap(&requester2, &target, &30i128),
        Err(Ok(Error::PrioritySwapAlreadyPending))
    );

    // The original request (requester1's) is still the one on record —
    // proven by target being able to accept it against requester1
    // specifically; accept_priority_swap rejects a requester mismatch.
    assert_eq!(
        client.try_accept_priority_swap(&target, &requester1),
        Ok(Ok(())),
        "requester1's original request must have survived untouched"
    );
}

#[test]
fn test_priority_swap_reject_refunds_escrowed_fee_and_allows_new_request() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, asset) = setup_pool_with_token(&env);
    create_default_pool(&env, &client, &organizer, &token, 3);
    join_all(&env, &client, 3);
    let pool = client.get_pool();
    let target = pool.queue.get_unchecked(0);
    let requester1 = pool.queue.get_unchecked(1);
    let requester2 = pool.queue.get_unchecked(2);
    let token_client = TokenClient::new(&env, &token);
    asset.mint(&requester1, &1000i128);
    asset.mint(&requester2, &1000i128);

    client.request_priority_swap(&requester1, &target, &50i128);
    assert_eq!(token_client.balance(&requester1), 950, "fee escrowed at request time");

    client.reject_priority_swap(&target);
    assert_eq!(
        token_client.balance(&requester1),
        1000,
        "rejected request must refund the escrowed fee back to requester1"
    );

    // Now that the first request is resolved, a new one may proceed.
    let res = client.try_request_priority_swap(&requester2, &target, &30i128);
    assert!(res.is_ok(), "a fresh request after resolution must be accepted");
}

// ---------- exit() debt guard ----------

#[test]
fn test_exit_blocked_by_outstanding_debt_before_payout() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, organizer, token, _asset) = setup_pool_with_token(&env);
    create_default_pool(&env, &client, &organizer, &token, 2);
    let members = join_all(&env, &client, 2);
    let m1 = members.get_unchecked(0);

    // m1 never contributes and misses the deadline — penalized into debt,
    // all before anyone has received a payout.
    env.ledger().set_timestamp(env.ledger().timestamp() + 259_200 + 1);
    client.penalize(&m1);
    assert!(client.get_member(&m1).balance_owed > 0);
    assert!(!client.get_member(&m1).received_payout);

    assert_eq!(
        client.try_exit(&m1),
        Err(Ok(Error::OutstandingDebt)),
        "debt must block exit even before this member has ever been paid out"
    );
}
