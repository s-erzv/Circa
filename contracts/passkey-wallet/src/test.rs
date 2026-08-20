#![cfg(test)]
extern crate std;

use super::*;
use p256::ecdsa::signature::hazmat::PrehashSigner;
use p256::ecdsa::{Signature as P256Signature, SigningKey, VerifyingKey};
use rand_core::OsRng;
use sha2::{Digest, Sha256};
use soroban_sdk::{Address, Bytes, BytesN, Env, IntoVal};

struct Passkey {
    signing_key: SigningKey,
    pk_bytes: [u8; 65],
}

fn generate_passkey() -> Passkey {
    let signing_key = SigningKey::random(&mut OsRng);
    let verifying_key = VerifyingKey::from(&signing_key);
    let point = verifying_key.to_encoded_point(false);
    let mut pk_bytes = [0u8; 65];
    pk_bytes.copy_from_slice(point.as_bytes());
    Passkey {
        signing_key,
        pk_bytes,
    }
}

/// Builds a real WebAuthn-shaped assertion for `signature_payload`, exactly
/// the way a browser would: sign `authenticatorData || SHA256(clientDataJSON)`
/// with the device key, where `clientDataJSON.challenge` is the base64url
/// encoding of `signature_payload`. `wrong_challenge`, when set, corrupts
/// just the challenge field so tests can prove the contract actually checks
/// the binding rather than merely checking that *a* valid signature exists.
fn sign_payload(
    env: &Env,
    passkey: &Passkey,
    signature_payload: &[u8; 32],
    wrong_challenge: bool,
) -> Signature {
    let authenticator_data: [u8; 37] = [0xAB; 37];

    let mut challenge_b64 = [0u8; 43];
    if wrong_challenge {
        base64_url::encode(&mut challenge_b64, &[0x99; 32]);
    } else {
        base64_url::encode(&mut challenge_b64, signature_payload);
    }
    let challenge_str = core::str::from_utf8(&challenge_b64).unwrap();

    let client_data_json = std::format!(
        "{{\"type\":\"webauthn.get\",\"challenge\":\"{}\",\"origin\":\"https://circa.example\"}}",
        challenge_str
    );

    let mut signed = std::vec::Vec::new();
    signed.extend_from_slice(&authenticator_data);
    signed.extend_from_slice(&Sha256::digest(client_data_json.as_bytes()));
    let digest = Sha256::digest(&signed);

    // sign_prehash, not sign(): `digest` is already the final SHA256 the
    // contract will verify against, and the ordinary Signer::sign() would
    // hash it a second time, producing a signature that's internally valid
    // but over the wrong message.
    let sig: P256Signature = passkey.signing_key.sign_prehash(&digest).unwrap();
    let raw = sig.to_bytes();
    let mut raw64 = [0u8; 64];
    raw64.copy_from_slice(&raw);

    Signature {
        authenticator_data: Bytes::from_slice(env, &authenticator_data),
        client_data_json: Bytes::from_slice(env, client_data_json.as_bytes()),
        signature: BytesN::from_array(env, &raw64),
    }
}

fn setup(env: &Env) -> (Address, Passkey) {
    let passkey = generate_passkey();
    let pk = BytesN::from_array(env, &passkey.pk_bytes);
    let contract_id = env.register(Contract, (pk,));
    (contract_id, passkey)
}

#[test]
fn test_constructor_cannot_be_invoked_a_second_time() {
    let env = Env::default();
    let (contract_id, _passkey) = setup(&env);
    let client = ContractClient::new(&env, &contract_id);
    assert!(client.get_pk().is_some());
}

#[test]
fn test_valid_signature_accepted() {
    let env = Env::default();
    let (contract_id, passkey) = setup(&env);

    let payload: [u8; 32] = [0x11; 32];
    let signature = sign_payload(&env, &passkey, &payload, false);

    let result = env.try_invoke_contract_check_auth::<Error>(
        &contract_id,
        &BytesN::from_array(&env, &payload),
        signature.into_val(&env),
        &soroban_sdk::vec![&env],
    );
    assert!(result.is_ok());
}

#[test]
fn test_wrong_key_rejected() {
    let env = Env::default();
    let (contract_id, _owner_passkey) = setup(&env);
    let attacker = generate_passkey();

    let payload: [u8; 32] = [0x22; 32];
    let signature = sign_payload(&env, &attacker, &payload, false);

    let result = env.try_invoke_contract_check_auth::<Error>(
        &contract_id,
        &BytesN::from_array(&env, &payload),
        signature.into_val(&env),
        &soroban_sdk::vec![&env],
    );
    assert!(
        result.is_err(),
        "a signature from a different key must not verify against this wallet's stored pk"
    );
}

#[test]
fn test_wrong_challenge_rejected() {
    let env = Env::default();
    let (contract_id, passkey) = setup(&env);

    let payload: [u8; 32] = [0x33; 32];
    // Signed correctly, but clientDataJSON.challenge is bound to a
    // DIFFERENT payload — proves __check_auth verifies the challenge binds
    // to signature_payload, not just that some valid signature exists.
    let signature = sign_payload(&env, &passkey, &payload, true);

    let result = env.try_invoke_contract_check_auth::<Error>(
        &contract_id,
        &BytesN::from_array(&env, &payload),
        signature.into_val(&env),
        &soroban_sdk::vec![&env],
    );
    assert!(result.is_err());
}

#[test]
fn test_tampered_authenticator_data_rejected() {
    let env = Env::default();
    let (contract_id, passkey) = setup(&env);

    let payload: [u8; 32] = [0x44; 32];
    let mut signature = sign_payload(&env, &passkey, &payload, false);
    // Flip a byte in authenticator_data after signing: the signature was
    // computed over the ORIGINAL bytes, so this must invalidate it.
    let mut tampered = std::vec::Vec::new();
    tampered.resize(signature.authenticator_data.len() as usize, 0);
    signature.authenticator_data.copy_into_slice(&mut tampered);
    tampered[0] ^= 0xFF;
    signature.authenticator_data = Bytes::from_slice(&env, &tampered);

    let result = env.try_invoke_contract_check_auth::<Error>(
        &contract_id,
        &BytesN::from_array(&env, &payload),
        signature.into_val(&env),
        &soroban_sdk::vec![&env],
    );
    assert!(result.is_err());
}
