#![cfg(test)]

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke};
use soroban_sdk::{Address, Env, IntoVal, Val};

mod pool_contract {
    soroban_sdk::contractimport!(
        file = "../../target/wasm32v1-none/release/arisan_pool.wasm"
    );
}

const WINDOW: u64 = 86_400;

/// Builds a live pool with `n` joined members and a gov contract wired to
/// it, returning both clients plus the member list.
fn setup(
    env: &Env,
    n: u32,
) -> (
    pool_contract::Client<'static>,
    ArisanGovClient<'static>,
    soroban_sdk::Vec<Address>,
) {
    let pool_id = env.register(pool_contract::WASM, ());
    let pool = pool_contract::Client::new(env, &pool_id);

    let organizer = Address::generate(env);
    let token_admin = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(token_admin);
    let token = sac.address();

    pool.create(
        &organizer,
        &token,
        &50i128,
        &n,
        &2_592_000u64,
        &259_200u64,
        &10i128,
        &5i128,
        &0u32,
    );

    let gov_id = env.register(ArisanGov, (pool_id.clone(), WINDOW));
    let gov = ArisanGovClient::new(env, &gov_id);
    pool.set_gov(&gov_id);

    let mut members = soroban_sdk::Vec::new(env);
    for _ in 0..n {
        let m = Address::generate(env);
        pool.join(&m);
        members.push_back(m);
    }

    (pool, gov, members)
}

/// Same as `setup`, but mints tokens to every member and returns the asset
/// client too, so a test can drive real contribute/distribute cycles.
fn setup_funded(
    env: &Env,
    n: u32,
) -> (
    pool_contract::Client<'static>,
    ArisanGovClient<'static>,
    soroban_sdk::Vec<Address>,
) {
    let pool_id = env.register(pool_contract::WASM, ());
    let pool = pool_contract::Client::new(env, &pool_id);

    let organizer = Address::generate(env);
    let token_admin = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(token_admin);
    let token = sac.address();
    let asset = soroban_sdk::token::StellarAssetClient::new(env, &token);

    pool.create(
        &organizer,
        &token,
        &50i128,
        &n,
        &2_592_000u64,
        &259_200u64,
        &10i128,
        &5i128,
        &0u32,
    );

    let gov_id = env.register(ArisanGov, (pool_id.clone(), WINDOW));
    let gov = ArisanGovClient::new(env, &gov_id);
    pool.set_gov(&gov_id);

    let mut members = soroban_sdk::Vec::new(env);
    for _ in 0..n {
        let m = Address::generate(env);
        asset.mint(&m, &1000i128);
        pool.join(&m);
        members.push_back(m);
    }

    (pool, gov, members)
}

#[test]
fn test_propose_rejected_before_pool_activation() {
    let env = Env::default();
    env.mock_all_auths();

    // A fresh 3-seat pool with only 2 joined — deliberately never activated.
    let pool_id = env.register(pool_contract::WASM, ());
    let pool2 = pool_contract::Client::new(&env, &pool_id);
    let organizer = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(token_admin);
    let token = sac.address();
    pool2.create(
        &organizer, &token, &50i128, &3u32, &2_592_000u64, &259_200u64, &10i128, &5i128, &0u32,
    );
    let gov_id = env.register(ArisanGov, (pool_id.clone(), WINDOW));
    let gov2 = ArisanGovClient::new(&env, &gov_id);
    pool2.set_gov(&gov_id);
    let m1 = Address::generate(&env);
    let m2 = Address::generate(&env);
    pool2.join(&m1);
    pool2.join(&m2);
    assert!(!pool2.is_activated());

    assert_eq!(
        gov2.try_propose(&m1, &ProposalKind::Kick(m1.clone())),
        Err(Ok(Error::PoolNotActivated)),
        "propose must refuse while the pool is still forming — the electorate \
         is not yet maximal, so any snapshot taken now would be a stale floor"
    );
}

#[test]
fn test_propose_and_vote_counts() {
    let env = Env::default();
    env.mock_all_auths();
    let (_pool, gov, members) = setup(&env, 4);

    let subject = members.get_unchecked(0);
    let proposer = members.get_unchecked(1);
    let id = gov.propose(&proposer, &ProposalKind::Kick(subject.clone()));

    // 4 members, subject excluded -> 3 eligible; 70% of 3 = 2.1 -> 3.
    assert_eq!(gov.eligible_voters(&id), 3);
    assert_eq!(gov.required_yes(&id), 3);

    gov.vote(&proposer, &id, &true);
    assert_eq!(gov.get_proposal(&id).yes_votes, 1);
    assert!(gov.has_voted(&id, &proposer));

    gov.vote(&members.get_unchecked(2), &id, &false);
    let p = gov.get_proposal(&id);
    assert_eq!(p.yes_votes, 1);
    assert_eq!(p.no_votes, 1);
}

#[test]
fn test_non_member_cannot_propose_or_vote() {
    let env = Env::default();
    env.mock_all_auths();
    let (_pool, gov, members) = setup(&env, 3);

    let outsider = Address::generate(&env);
    let subject = members.get_unchecked(0);
    assert_eq!(
        gov.try_propose(&outsider, &ProposalKind::Kick(subject.clone())),
        Err(Ok(Error::NotAMember))
    );

    let id = gov.propose(&members.get_unchecked(1), &ProposalKind::Kick(subject));
    assert_eq!(
        gov.try_vote(&outsider, &id, &true),
        Err(Ok(Error::NotAMember))
    );
}

#[test]
fn test_subject_cannot_vote_on_own_proposal() {
    let env = Env::default();
    env.mock_all_auths();
    let (_pool, gov, members) = setup(&env, 3);
    let subject = members.get_unchecked(0);
    let id = gov.propose(&members.get_unchecked(1), &ProposalKind::Kick(subject.clone()));

    assert_eq!(
        gov.try_vote(&subject, &id, &false),
        Err(Ok(Error::SubjectCannotVote))
    );
}

#[test]
fn test_double_voting_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (_pool, gov, members) = setup(&env, 3);
    let subject = members.get_unchecked(0);
    let voter = members.get_unchecked(1);
    let id = gov.propose(&voter, &ProposalKind::Kick(subject.clone()));

    gov.vote(&voter, &id, &true);
    assert_eq!(gov.try_vote(&voter, &id, &true), Err(Ok(Error::AlreadyVoted)));
}

#[test]
fn test_voting_after_deadline_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (_pool, gov, members) = setup(&env, 3);
    let subject = members.get_unchecked(0);
    let voter = members.get_unchecked(1);
    let id = gov.propose(&voter, &ProposalKind::Kick(subject.clone()));

    env.ledger()
        .set_timestamp(env.ledger().timestamp() + WINDOW + 1);
    assert_eq!(gov.try_vote(&voter, &id, &true), Err(Ok(Error::VotingClosed)));
}

#[test]
fn test_proposal_against_non_member_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (_pool, gov, members) = setup(&env, 3);

    let outsider = Address::generate(&env);
    assert_eq!(
        gov.try_propose(&members.get_unchecked(0), &ProposalKind::Kick(outsider)),
        Err(Ok(Error::SubjectNotAMember))
    );
}

#[test]
fn test_kick_executes_and_removes_member_from_pool() {
    let env = Env::default();
    env.mock_all_auths();
    let (pool, gov, members) = setup(&env, 4);

    let subject = members.get_unchecked(0);
    let id = gov.propose(&members.get_unchecked(1), &ProposalKind::Kick(subject.clone()));

    // 3 eligible, all 3 must approve.
    gov.vote(&members.get_unchecked(1), &id, &true);
    gov.vote(&members.get_unchecked(2), &id, &true);
    gov.vote(&members.get_unchecked(3), &id, &true);

    gov.execute(&id);

    assert!(gov.get_proposal(&id).executed);
    assert!(pool.get_member(&subject).exited);
    assert!(!pool.get_pool().members.contains(&subject));
}

#[test]
fn test_skip_executes_and_defers_turn() {
    let env = Env::default();
    env.mock_all_auths();
    let (pool, gov, members) = setup(&env, 4);

    let subject = members.get_unchecked(0);
    let before_pos = pool.get_pool().queue.first_index_of(&subject).unwrap();
    let id = gov.propose(&members.get_unchecked(1), &ProposalKind::Skip(subject.clone()));
    gov.vote(&members.get_unchecked(1), &id, &true);
    gov.vote(&members.get_unchecked(2), &id, &true);
    gov.vote(&members.get_unchecked(3), &id, &true);
    gov.execute(&id);

    let after_pos = pool.get_pool().queue.first_index_of(&subject).unwrap();
    assert_eq!(after_pos, pool.get_pool().queue.len() - 1);
    let _ = before_pos;
    assert!(pool.get_pool().members.contains(&subject));
}

#[test]
fn test_below_threshold_cannot_execute_even_with_majority_of_votes_cast() {
    let env = Env::default();
    env.mock_all_auths();
    let (_pool, gov, members) = setup(&env, 4);
    let subject = members.get_unchecked(0);
    let id = gov.propose(&members.get_unchecked(1), &ProposalKind::Kick(subject.clone()));

    // Only 2 of 3 eligible vote yes — majority of votes CAST, but below the
    // 70%-of-eligible bar (3 needed).
    gov.vote(&members.get_unchecked(1), &id, &true);
    gov.vote(&members.get_unchecked(2), &id, &true);

    assert_eq!(gov.try_execute(&id), Err(Ok(Error::ThresholdNotMet)));
}

#[test]
fn test_execute_twice_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (_pool, gov, members) = setup(&env, 3);
    let subject = members.get_unchecked(0);
    let id = gov.propose(&members.get_unchecked(1), &ProposalKind::Kick(subject.clone()));
    gov.vote(&members.get_unchecked(1), &id, &true);
    gov.vote(&members.get_unchecked(2), &id, &true);
    gov.execute(&id);

    assert_eq!(gov.try_execute(&id), Err(Ok(Error::AlreadyExecuted)));
}

#[test]
fn test_decided_proposal_still_executable_after_deadline() {
    let env = Env::default();
    env.mock_all_auths();
    let (_pool, gov, members) = setup(&env, 3);
    let subject = members.get_unchecked(0);
    let id = gov.propose(&members.get_unchecked(1), &ProposalKind::Kick(subject.clone()));
    gov.vote(&members.get_unchecked(1), &id, &true);
    gov.vote(&members.get_unchecked(2), &id, &true);

    // execute() is deliberately deadline-free: a proposal that has already
    // cleared its bar must not become un-executable just because nobody
    // called execute() before the voting window closed. Killing a decided
    // proposal by running out the clock would be its own attack.
    env.ledger()
        .set_timestamp(env.ledger().timestamp() + WINDOW + 1);
    assert!(gov.try_execute(&id).is_ok());
}

/// Critical 1 regression: a dissenting NO voter exits after a proposal is
/// DEFEATED, shrinking the live electorate and — without the propose-time
/// snapshot floor — lowering the live bar below the already-cast
/// (insufficient) yes votes, flipping a defeated proposal to passing with
/// no new votes cast.
#[test]
fn test_shrinking_electorate_cannot_flip_defeated_proposal() {
    let env = Env::default();
    env.mock_all_auths();
    let (pool, gov, members) = setup(&env, 4);
    let subject = members.get_unchecked(0);
    let id = gov.propose(&members.get_unchecked(1), &ProposalKind::Kick(subject.clone()));

    // 3 eligible, bar = 3. Only 1 yes vote — defeated.
    gov.vote(&members.get_unchecked(1), &id, &true);
    gov.vote(&members.get_unchecked(2), &id, &false);
    gov.vote(&members.get_unchecked(3), &id, &false);
    assert_eq!(gov.try_execute(&id), Err(Ok(Error::ThresholdNotMet)));

    // Two dissenters exit, shrinking live eligible to 1 (just the
    // proposer). Without the snapshot floor, live bar would drop to 1,
    // matching the single banked yes vote.
    pool.exit(&members.get_unchecked(2));
    pool.exit(&members.get_unchecked(3));

    assert_eq!(
        gov.try_execute(&id),
        Err(Ok(Error::ThresholdNotMet)),
        "the propose-time snapshot must still bind after the electorate shrinks"
    );
}

/// Critical 2 regression + I3 interaction: the original Critical 2 showed
/// that an electorate of exactly 0 at propose time snapshots `required_yes`
/// at 0 (ceil(0 * 70 / 100) == 0), letting a completely unvoted execute go
/// through. That was fixed with a `yes_votes >= 1` floor in `execute`. I3's
/// electorate floor of 2 now catches this even earlier: `propose` itself
/// rejects when `eligible < 2`, so the scenario that surfaced Critical 2
/// (last member proposing against themselves) is now blocked at the gate.
#[test]
fn test_zero_votes_cannot_execute() {
    let env = Env::default();
    env.mock_all_auths();
    let (pool, gov, members) = setup(&env, 3);

    let other = members.get_unchecked(1);
    let last = members.get_unchecked(2);
    pool.exit(&members.get_unchecked(0));
    pool.exit(&other);

    // Only `last` remains active; they propose against themselves.
    assert_eq!(
        gov.try_propose(&last, &ProposalKind::Kick(last.clone())),
        Err(Ok(Error::ElectorateTooSmall)),
        "propose must reject when the electorate is too small to form \
         a meaningful vote (eligible < 2)"
    );
    assert!(!pool.get_member(&last).exited);
}

/// I3 regression: at `eligible == 1` the 70% threshold collapses to a
/// single vote (ceil(1 * 70 / 100) == 1), handing the last remaining member
/// unilateral power to kick or skip the only other member — no coordination,
/// no real majority. Unlike the earlier Critical bugs, this needs no
/// attacker at all: ordinary attrition reaches it.
#[test]
fn test_unilateral_kick_impossible_when_only_one_other_member_remains() {
    let env = Env::default();
    env.mock_all_auths();
    let (pool, gov, members) = setup(&env, 3);

    let subject = members.get_unchecked(0);
    let survivor = members.get_unchecked(1);
    pool.exit(&members.get_unchecked(2));
    assert_eq!(pool.get_pool().members.len(), 2);

    assert_eq!(
        gov.try_propose(&survivor, &ProposalKind::Kick(subject.clone())),
        Err(Ok(Error::ElectorateTooSmall)),
        "with only one eligible voter the 70% bar collapses to a single \
         vote — one member must never be able to remove another alone"
    );
    assert!(!pool.get_member(&subject).exited);

    assert_eq!(
        gov.try_propose(&survivor, &ProposalKind::Skip(subject.clone())),
        Err(Ok(Error::ElectorateTooSmall))
    );
}

/// Critical 4 regression: an attacker arms a Kick proposal at the
/// electorate's minimum size (2 members, bar=1), banks a sybil yes-vote,
/// lets the pool fill and fund normally, then EXITS the sybil. Before the
/// activation gate, `max(snapshot, live)` was only as strong as its weaker
/// term — the banked snapshot stayed low while `live` collapsed back down
/// to match it, letting a stale minimum-bar proposal execute against a
/// fully-formed, funded pool with zero honest support. Gating `propose` on
/// `pool.activated` closes this at the root: the electorate is already
/// maximal at snapshot time, so `live` can never exceed it again.
#[test]
fn test_banked_votes_cannot_be_revived_by_exiting_yes_voters_post_activation() {
    let env = Env::default();
    env.mock_all_auths();
    // With the activation gate, this exact attack shape cannot even start:
    // propose() is refused before the pool activates. Confirmed directly.
    let pool_id = env.register(pool_contract::WASM, ());
    let pool = pool_contract::Client::new(&env, &pool_id);
    let organizer = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(token_admin);
    let token = sac.address();
    pool.create(
        &organizer, &token, &50i128, &8u32, &2_592_000u64, &259_200u64, &10i128, &5i128, &0u32,
    );
    let gov_id = env.register(ArisanGov, (pool_id.clone(), WINDOW));
    let gov = ArisanGovClient::new(&env, &gov_id);
    pool.set_gov(&gov_id);

    let m1 = Address::generate(&env);
    let m2 = Address::generate(&env);
    pool.join(&m1);
    pool.join(&m2);
    assert!(!pool.is_activated());

    assert_eq!(
        gov.try_propose(&m1, &ProposalKind::Kick(m2.clone())),
        Err(Ok(Error::PoolNotActivated)),
        "the attack requires arming a proposal pre-activation at a low bar \
         — the activation gate removes that window entirely"
    );
}

#[test]
fn test_propose_requires_proposer_auth() {
    let env = Env::default();
    let (_pool, gov, members) = setup_via_mock_all_then_real(&env, 3);
    let subject = members.get_unchecked(0);
    let proposer = members.get_unchecked(1);

    let impostor = Address::generate(&env);
    let args: soroban_sdk::Vec<Val> =
        (impostor.clone(), ProposalKind::Kick(subject.clone())).into_val(&env);
    let res = gov
        .mock_auths(&[MockAuth {
            address: &impostor,
            invoke: &MockAuthInvoke {
                contract: &gov.address,
                fn_name: "propose",
                args: args.clone(),
                sub_invokes: &[],
            },
        }])
        .try_propose(&proposer, &ProposalKind::Kick(subject.clone()));
    assert!(res.is_err(), "someone else authorizing cannot propose on proposer's behalf");

    // Positive control: proposer authorizing for real succeeds.
    let real_args: soroban_sdk::Vec<Val> =
        (proposer.clone(), ProposalKind::Kick(subject.clone())).into_val(&env);
    gov.mock_auths(&[MockAuth {
        address: &proposer,
        invoke: &MockAuthInvoke {
            contract: &gov.address,
            fn_name: "propose",
            args: real_args,
            sub_invokes: &[],
        },
    }])
    .propose(&proposer, &ProposalKind::Kick(subject));
}

#[test]
fn test_vote_requires_voter_auth() {
    let env = Env::default();
    let (_pool, gov, members) = setup_via_mock_all_then_real(&env, 3);
    let subject = members.get_unchecked(0);
    let proposer = members.get_unchecked(1);
    let voter = members.get_unchecked(2);

    let real_id = {
        env.mock_all_auths();
        gov.propose(&proposer, &ProposalKind::Kick(subject))
    };

    let args: soroban_sdk::Vec<Val> = (voter.clone(), real_id, true).into_val(&env);
    let res = gov
        .mock_auths(&[MockAuth {
            address: &Address::generate(&env),
            invoke: &MockAuthInvoke {
                contract: &gov.address,
                fn_name: "vote",
                args: args.clone(),
                sub_invokes: &[],
            },
        }])
        .try_vote(&voter, &real_id, &true);
    assert!(res.is_err());
    assert!(!gov.has_voted(&real_id, &voter));

    gov.mock_auths(&[MockAuth {
        address: &voter,
        invoke: &MockAuthInvoke {
            contract: &gov.address,
            fn_name: "vote",
            args,
            sub_invokes: &[],
        },
    }])
    .vote(&voter, &real_id, &true);
    assert!(gov.has_voted(&real_id, &voter));
}

/// Helper for the auth tests: builds the pool+gov the same way `setup`
/// does, but the caller mocks auths explicitly per-call afterward.
fn setup_via_mock_all_then_real(
    env: &Env,
    n: u32,
) -> (
    pool_contract::Client<'static>,
    ArisanGovClient<'static>,
    soroban_sdk::Vec<Address>,
) {
    env.mock_all_auths();
    setup(env, n)
}

#[test]
fn test_gov_kick_rejected_on_closed_pool() {
    let env = Env::default();
    env.mock_all_auths();
    let (pool, gov, members) = setup_funded(&env, 2);

    for _ in 0..2 {
        for m in members.iter() {
            if !pool.get_member(&m).contributed_this_cycle && !pool.get_member(&m).exited {
                let _ = pool.try_contribute(&m);
            }
        }
        env.ledger()
            .set_timestamp(env.ledger().timestamp() + 259_200 + 1);
        let _ = pool.try_distribute();
    }
    assert!(pool.get_pool().closed);

    // Even a well-formed, fully-approved-shape proposal cannot be proposed
    // against a closed pool.
    let subject = members.get_unchecked(0);
    let proposer = members.get_unchecked(1);
    assert_eq!(
        gov.try_propose(&proposer, &ProposalKind::Kick(subject)),
        Err(Ok(Error::PoolClosed))
    );
}

/// I5 regression: `execute` is deliberately permissionless and deliberately
/// has NO deadline — a decided proposal must not be defeatable by running
/// out the clock. That combination means an approved Kick can sit
/// indefinitely while the pool's state moves underneath it. gov_kick
/// behaves differently depending on the subject's payout status, so voters
/// approving one outcome must never silently get another.
#[test]
fn test_kick_rejected_when_subject_payout_status_drifts() {
    let env = Env::default();
    env.mock_all_auths();
    let (pool, gov, members) = setup_funded(&env, 4);

    let subject = pool.get_pool().queue.get_unchecked(0);
    assert!(!pool.get_member(&subject).received_payout);

    let proposer = members
        .iter()
        .find(|m| *m != subject)
        .expect("a 4-member pool always has a non-subject member");

    let id = gov.propose(&proposer, &ProposalKind::Kick(subject.clone()));
    assert!(
        !gov.get_proposal(&id).payout_snapshot,
        "snapshot must record the subject as unpaid at propose time"
    );

    for m in members.iter() {
        if m != subject {
            gov.vote(&m, &id, &true);
        }
    }
    assert_eq!(gov.get_proposal(&id).yes_votes, 3);

    // Cycle completes normally and the subject receives their payout —
    // the exact state change the voters never agreed to kick under.
    for m in members.iter() {
        pool.contribute(&m);
    }
    env.ledger()
        .set_timestamp(env.ledger().timestamp() + 259_200 + 1);
    pool.distribute();
    assert!(pool.get_member(&subject).received_payout);

    assert_eq!(
        gov.try_execute(&id),
        Err(Ok(Error::SubjectStateChanged)),
        "a decided Kick must not fire once the subject's payout status has \
         changed — it would execute under materially different terms than \
         the ones voted on"
    );
    assert!(!pool.get_member(&subject).exited);
    assert!(!gov.get_proposal(&id).executed);
}
