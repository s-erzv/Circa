use soroban_sdk::{Address, Env, Vec};

// Not cryptographically secure — seeded from ledger state at activation
// time. Acceptable for testnet/MVP; flagged for hardening (VRF/oracle)
// before mainnet per the design spec.
pub fn draw_order(env: &Env, members: &Vec<Address>) -> Vec<Address> {
    let mut seed: u64 = env
        .ledger()
        .timestamp()
        .wrapping_mul(6364136223846793005)
        .wrapping_add(env.ledger().sequence() as u64);
    seed |= 1;

    let mut items: Vec<Address> = members.clone();
    let n: u32 = items.len();
    let mut i: u32 = n;
    while i > 1 {
        i -= 1;
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        let j: u32 = (seed % ((i as u64) + 1)) as u32;
        let a = items.get_unchecked(i);
        let b = items.get_unchecked(j);
        items.set(i, b);
        items.set(j, a);
    }
    items
}
