#![no_std]
use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contracterror, contractimpl, contracttype,
    crypto::Hash,
    symbol_short, Bytes, BytesN, Env, Symbol, Vec,
};

mod base64_url;

#[contract]
pub struct Contract;

#[contracterror]
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
#[repr(u32)]
pub enum Error {
    NotInited = 1,
    ClientDataJsonChallengeIncorrect = 3,
    JsonParseError = 4,
}

const STORAGE_KEY_PK: Symbol = symbol_short!("pk");

#[contractimpl]
impl Contract {
    /// Invoked automatically and atomically by the host as part of the
    /// `create_contract` operation itself (see soroban-sdk `Env::register`
    /// docs). It is not a regular invokable function: it cannot be called
    /// again after deployment, and there is no window between "deployed"
    /// and "initialized" during which another party could race to set the
    /// owning key. This closes the front-running window that existed when
    /// this logic lived in a plain `init` function called as a separate,
    /// unauthenticated follow-up transaction.
    #[allow(non_snake_case)]
    pub fn __constructor(env: Env, pk: BytesN<65>) {
        env.storage().instance().set(&STORAGE_KEY_PK, &pk);
    }

    pub fn get_pk(env: Env) -> Option<BytesN<65>> {
        env.storage().instance().get(&STORAGE_KEY_PK)
    }
}

#[contracttype]
pub struct Signature {
    pub authenticator_data: Bytes,
    pub client_data_json: Bytes,
    pub signature: BytesN<64>,
}

#[derive(serde::Deserialize)]
struct ClientDataJson<'a> {
    challenge: &'a str,
}

#[contractimpl]
impl CustomAccountInterface for Contract {
    type Error = Error;
    type Signature = Signature;

    #[allow(non_snake_case)]
    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signature: Signature,
        _auth_contexts: Vec<Context>,
    ) -> Result<(), Error> {
        let pk: BytesN<65> = env
            .storage()
            .instance()
            .get(&STORAGE_KEY_PK)
            .ok_or(Error::NotInited)?;

        let mut payload = Bytes::new(&env);
        payload.append(&signature.authenticator_data);
        payload.extend_from_array(&env.crypto().sha256(&signature.client_data_json).to_array());
        let payload = env.crypto().sha256(&payload);

        env.crypto()
            .secp256r1_verify(&pk, &payload, &signature.signature);

        let client_data_json = signature.client_data_json.to_buffer::<1024>();
        let client_data_json = client_data_json.as_slice();
        let (client_data, _): (ClientDataJson, _) =
            serde_json_core::de::from_slice(client_data_json).map_err(|_| Error::JsonParseError)?;

        let mut expected_challenge = *b"___________________________________________";
        base64_url::encode(&mut expected_challenge, &signature_payload.to_array());

        if client_data.challenge.as_bytes() != expected_challenge {
            return Err(Error::ClientDataJsonChallengeIncorrect);
        }

        Ok(())
    }
}

mod test;
